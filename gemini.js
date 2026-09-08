// gemini.js — cliente da API do Gemini para o Hub CN2O.
// Sem dependências: usa o fetch nativo do Node 18+.
//
// Os IDs de modelo vêm de variáveis de ambiente porque o Google troca a
// nomenclatura com frequência. Se um ID cair, basta editar a variável no
// Railway — nenhuma alteração de código. GET /agentes/modelos lista o que
// a chave enxerga de verdade.

const API = 'https://generativelanguage.googleapis.com/v1beta';

const MODELO_EXTRACAO = process.env.GEMINI_MODEL_EXTRACAO || 'gemini-3.5-flash-lite';
const MODELO_REDACAO  = process.env.GEMINI_MODEL_REDACAO  || 'gemini-3.8-flash';

// Preço de tabela em USD por 1 milhão de tokens: [entrada, saída].
// Serve só para o log de consumo — errar aqui não quebra nada, só a estimativa.
// ATENÇÃO: o preço introdutório do 3.8 Flash (0,75/3,75) vale até 31/12/2026.
// A partir de 01/01/2027 a tabela cheia é 1,50/7,50 — atualize esta linha.
const PRECOS = {
  'gemini-2.5-flash-lite': [0.10, 0.40],
  'gemini-3.5-flash-lite': [0.30, 2.50],
  'gemini-3.8-flash':      [0.75, 3.75],
  'gemini-3.7-flash':      [0.75, 3.75],
  'gemini-3.1-pro':        [2.00, 12.00]
};

function chave() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error('GEMINI_API_KEY não configurada nas variáveis do serviço');
  return k;
}

function custoUsd(modelo, entrada, saida) {
  const p = PRECOS[modelo] || PRECOS[MODELO_REDACAO] || [0, 0];
  return (entrada / 1e6) * p[0] + (saida / 1e6) * p[1];
}

// O erro mais perigoso deste sistema seria uma minuta cortada no meio que parece
// pronta. O Gemini avisa pelo finishReason quando estourou o limite de saída;
// aqui isso vira erro, nunca um texto salvo pela metade.
function exigirCompleto(r, oQue) {
  if (r.finish === 'MAX_TOKENS') {
    throw new Error(
      `${oQue} excedeu o limite de saída do modelo e saiu truncada. ` +
      'Nada foi gravado. Reduza o caso (menos documentos por vez) ou divida o ato.'
    );
  }
  if (!r.texto) {
    throw new Error(`${oQue} voltou vazia do modelo (motivo: ${r.finish || 'desconhecido'})`);
  }
  return r;
}

// Converte os anexos do formulário em "parts" que o Gemini lê nativamente.
// O Gemini enxerga PDF e imagem direto — não precisa de OCR separado.
function partesDeArquivos(arquivos = []) {
  return arquivos
    .filter(a => a && a.base64 && a.mime)
    .map(a => ({ inline_data: { mime_type: a.mime, data: a.base64 } }));
}

// Sem timeout explícito o fetch do Node espera para sempre. Como o serviço roda
// com uma réplica só e divide o processo com o /protocolo do balcão, uma chamada
// pendurada não trava só o agente: trava o cartório inteiro.
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 180000;

async function chamar({ modelo, sistema, partes, temperatura = 0.2, maxTokens = 32768, json = false, busca = false }) {
  const corpo = {
    contents: [{ role: 'user', parts: partes }],
    generationConfig: {
      temperature: temperatura,
      maxOutputTokens: maxTokens,
      ...(json ? { responseMimeType: 'application/json' } : {})
    }
  };
  if (sistema) corpo.systemInstruction = { parts: [{ text: sistema }] };
  // Busca na web. No app do Gemini o Gem pesquisa sozinho; pela API isso não
  // existe a menos que a ferramenta seja declarada. Sem ela, um prompt que manda
  // "pesquise valores praticados" não tem como obedecer — e o modelo ou inventa
  // comparativos ou diz sempre que não achou nada.
  // Incompatível com responseMimeType JSON, por isso os dois nunca vêm juntos.
  if (busca && !json) corpo.tools = [{ google_search: {} }];

  let r;
  try {
    r = await fetch(`${API}/models/${modelo}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': chave() },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new Error(`o modelo não respondeu em ${Math.round(TIMEOUT_MS / 1000)}s — tente de novo`);
    }
    throw e;
  }

  const txt = await r.text();
  if (!r.ok) throw new Error(`Gemini ${modelo} ${r.status}: ${txt.slice(0, 400)}`);

  let j;
  try { j = JSON.parse(txt); }
  catch (e) { throw new Error(`Gemini ${modelo}: resposta não é JSON — ${txt.slice(0, 200)}`); }

  const cand = (j.candidates || [])[0];
  if (!cand) {
    const bloqueio = j.promptFeedback && j.promptFeedback.blockReason;
    throw new Error(bloqueio ? `Gemini bloqueou a requisição (${bloqueio})` : 'Gemini não retornou candidato');
  }

  const texto = (cand.content && cand.content.parts || [])
    .map(p => p.text || '')
    .join('')
    .trim();

  const u = j.usageMetadata || {};
  const entrada = u.promptTokenCount || 0;
  const saida   = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);

  return {
    texto,
    modelo,
    tokens_entrada: entrada,
    tokens_saida: saida,
    custo_usd: custoUsd(modelo, entrada, saida),
    finish: cand.finishReason || null
  };
}

// ---------------------------------------------------------------- ETAPA 1
// Extração: documentos (PDF/imagem) → JSON com os campos do ato.
// Roda no modelo barato. A usuária confere o JSON na tela antes de redigir.
async function extrair({ agente, arquivos, observacoes, modelo }) {
  const campos = Array.isArray(agente.campos) ? agente.campos : [];
  const esquema = campos.map(c =>
    `- ${c.id} (${c.tipo || 'texto'})${c.obrigatorio ? ' [OBRIGATÓRIO]' : ''}: ${c.rotulo || ''}`
  ).join('\n');

  const sistema = [
    'Você é o extrator de dados do Cartório de Notas do 2º Ofício de Itabaiana/SE.',
    'Sua única função é ler os documentos anexados e devolver um objeto JSON com os campos pedidos.',
    '',
    'REGRAS INVIOLÁVEIS:',
    '1. NUNCA invente, infira ou complete um dado. Campo ausente, ilegível ou duvidoso recebe exatamente a string "[VERIFICAR]".',
    '2. Transcreva descrições de imóvel ipsis litteris: não corrija grafia, não arredonde metragens, não reordene confrontações, não converta unidades.',
    '3. Números de documento (CPF, RG, matrícula, inscrição imobiliária) vão com a pontuação exatamente como no original.',
    '4. Valores monetários em formato "1.234,56" (sem o "R$").',
    '5. Datas no formato DD/MM/AAAA.',
    '6. Responda SOMENTE o JSON. Sem preâmbulo, sem markdown, sem comentário.',
    '',
    'Além dos campos pedidos, inclua sempre a chave "_alertas": um array de strings com',
    'divergências entre documentos, campos ilegíveis, ônus ou indisponibilidade averbados,',
    'folhas faltantes e erros materiais reproduzidos. Array vazio se não houver nada.',
    '',
    'CAMPOS A EXTRAIR:',
    esquema || '(nenhum campo declarado — devolva tudo que conseguir identificar)'
  ].join('\n');

  const partes = [
    ...partesDeArquivos(arquivos),
    { text: observacoes
        ? `Observações da escrevente sobre este caso:\n${observacoes}\n\nExtraia os campos.`
        : 'Extraia os campos dos documentos acima.' }
  ];

  const r = await chamar({
    modelo: modelo || agente.modelo_extracao || MODELO_EXTRACAO,
    sistema, partes, temperatura: 0, json: true, maxTokens: 16384
  });

  let dados;
  try {
    dados = JSON.parse(r.texto);
  } catch (e) {
    // Rede de segurança: às vezes vem cercado de crase apesar do responseMimeType.
    const m = r.texto.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('a extração não devolveu JSON válido');
    dados = JSON.parse(m[0]);
  }
  return { dados, uso: r };
}

// ---------------------------------------------------------------- ETAPA 2
// Redação: JSON conferido + template do ato → minuta completa.
async function redigir({ agente, dados, observacoes, modelo }) {
  const sistema = [
    agente.prompt_sistema,
    agente.template ? '\n\n===== TEMPLATE VIGENTE DO ATO (siga a estrutura e as cláusulas condicionais) =====\n' + agente.template : ''
  ].join('');

  const partes = [{
    text: [
      'DADOS DO ATO (já conferidos pela escrevente — use apenas estes; não invente nada):',
      '```json',
      JSON.stringify(dados, null, 2),
      '```',
      observacoes ? `\nOBSERVAÇÕES DA ESCREVENTE:\n${observacoes}` : '',
      '',
      'Redija a minuta completa, pronta para o livro, no padrão do CN2O.',
      'Todo dado marcado "[VERIFICAR]" deve aparecer na minuta como [VERIFICAR] — jamais preenchido por conta própria.',
      'Não escreva preâmbulo nem comentário: comece direto pelo texto da escritura.'
    ].join('\n')
  }];

  const r = exigirCompleto(await chamar({
    modelo: modelo || agente.modelo_redacao || MODELO_REDACAO,
    sistema, partes, temperatura: 0.2, maxTokens: 32768
  }), 'a minuta');
  return { texto: r.texto, uso: r };
}

// ---------------------------------------------------------------- ETAPA 3
// Revisão: minuta + pedido de ajuste → minuta corrigida por inteiro.
async function revisar({ agente, minutaAtual, pedido, historico = [], modelo }) {
  const sistema = [
    agente.prompt_sistema,
    agente.template ? '\n\n===== TEMPLATE VIGENTE DO ATO =====\n' + agente.template : '',
    '\n\n===== MODO REVISÃO =====',
    'Você está revisando uma minuta já redigida. Aplique EXATAMENTE o ajuste pedido.',
    'Devolva a MINUTA INTEIRA corrigida, do começo ao fim — nunca só o trecho alterado,',
    'nunca um diff, nunca "restante inalterado". Sem preâmbulo e sem comentário final.'
  ].join('');

  const contexto = historico.length
    ? '\n\nAJUSTES JÁ PEDIDOS NESTA MINUTA:\n' + historico.map((h, i) => `${i + 1}. ${h}`).join('\n')
    : '';

  const partes = [{
    text: [
      'MINUTA ATUAL:', '---', minutaAtual, '---',
      contexto,
      '', 'AJUSTE PEDIDO AGORA:', pedido,
      '', 'Devolva a minuta inteira já corrigida.'
    ].join('\n')
  }];

  const r = exigirCompleto(await chamar({
    modelo: modelo || agente.modelo_redacao || MODELO_REDACAO,
    sistema, partes, temperatura: 0.2, maxTokens: 32768
  }), 'a revisão da minuta');
  return { texto: r.texto, uso: r };
}

// ------------------------------------------------------- ETAPA ÚNICA
// Ferramentas e comunicação não são escrituras: não têm template, não passam por
// conferência de JSON e não viram minuta em três turnos. Entra documento ou
// formulário, sai texto. Uma chamada só.
async function executar({ agente, arquivos = [], campos = {}, observacoes, modelo }) {
  const preenchidos = Object.entries(campos)
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k, v]) => `${k}: ${v}`);

  // Os documentos vêm ANTES das instruções: com material longo o modelo ancora
  // melhor a transcrição literal assim (é a nota de implantação do próprio
  // Not-Extrator, e vale para qualquer agente que transcreva).
  const partes = [
    ...partesDeArquivos(arquivos),
    { text: [
        preenchidos.length ? 'DADOS INFORMADOS:\n' + preenchidos.join('\n') : '',
        observacoes ? `\nOBSERVAÇÕES:\n${observacoes}` : '',
        arquivos.length ? '\nOs documentos acima fazem parte do pedido.' : '',
        '\nExecute a sua função sobre o material acima, no formato de saída que as',
        'suas instruções definem. Responda apenas com o resultado — sem preâmbulo,',
        'sem "segue abaixo", sem comentário final.'
      ].filter(Boolean).join('\n') }
  ];

  // Temperatura 0 por padrão: ferramenta de transcrição não se beneficia de
  // variabilidade, e o Not-Extrator exige cópia ipsis litteris.
  const r = exigirCompleto(await chamar({
    modelo: modelo || agente.modelo_redacao || MODELO_REDACAO,
    sistema: agente.prompt_sistema,
    partes,
    temperatura: agente.temperatura == null ? 0 : Number(agente.temperatura),
    busca: !!agente.usa_busca,
    maxTokens: 32768
  }), 'a resposta');
  return { texto: r.texto, uso: r };
}

// Lista os modelos que a chave enxerga — para conferir os IDs sem adivinhação.
async function listarModelos() {
  const r = await fetch(`${API}/models`, { headers: { 'x-goog-api-key': chave() } });
  if (!r.ok) throw new Error(`Gemini models ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => ({
      id: (m.name || '').replace('models/', ''),
      nome: m.displayName,
      entrada: m.inputTokenLimit,
      saida: m.outputTokenLimit
    }));
}

module.exports = {
  extrair, redigir, revisar, executar, listarModelos, custoUsd,
  MODELO_EXTRACAO, MODELO_REDACAO, PRECOS
};
