// claude.js — cliente da API Claude (Anthropic) para o Hub CN2O. v1.49: substitui o gemini.js.
// Usa o SDK oficial (@anthropic-ai/sdk) e a chave ANTHROPIC_API_KEY.
//
// Cada ação do Hub tem um PERFIL: modelo + esforço (output_config.effort) + teto de saída,
// escolhido pela dificuldade da tarefa — a minuta vai no Opus com esforço alto; a leitura
// literal da descrição vai no Sonnet com esforço baixo; a análise de números da
// produtividade vai no Haiku. Para trocar um perfil sem deploy, variável no Railway:
//   IA_PERFIL_MINUTA=claude-sonnet-5-5:medium      (tarefa em maiúsculas, "-" vira "_")

const fonteContrato = require('./protocolo-fonte');
const fonteIA = require('./protocolo-fonte-ia');

const OPUS = 'claude-opus-5-5', SONNET = 'claude-sonnet-5-5', HAIKU = 'claude-haiku-5-5';
const ESFORCOS = ['low', 'medium', 'high', 'xhigh', 'max'];

// tarefa → { modelo, esforco, maxTokens, cache }. cache: o prompt de sistema é grande e se
// repete a cada chamada — vai para o cache de prompt (a releitura custa 5% do preço).
// maxTokens inclui o raciocínio (que também é saída): o Opus em esforço alto tem folga.
const PERFIS = {
  // Hub — /hub/ia/:ferramenta
  'minuta':          { modelo: OPUS,   esforco: 'high',   maxTokens: 64000, cache: true },
  'minuta_ue':       { modelo: OPUS,   esforco: 'high',   maxTokens: 64000, cache: true },
  'matricula':       { modelo: OPUS,   esforco: 'medium', maxTokens: 32000 },
  'itcmd':           { modelo: SONNET, esforco: 'high',   maxTokens: 48000 },
  'qualificacao':    { modelo: SONNET, esforco: 'medium', maxTokens: 32000 },
  'descricao':       { modelo: SONNET, esforco: 'low',    maxTokens: 32000 },
  'transpor':        { modelo: SONNET, esforco: 'low',    maxTokens: 32000 },
  'redator':         { modelo: SONNET, esforco: 'low',    maxTokens: 32000 },
  // Plataforma de Agentes — /agentes
  'agente-redigir':  { modelo: OPUS,   esforco: 'high',   maxTokens: 64000, cache: true },
  'agente-revisar':  { modelo: OPUS,   esforco: 'medium', maxTokens: 64000, cache: true },
  'agente-extrair':  { modelo: SONNET, esforco: 'medium', maxTokens: 32000 },
  'agente-executar': { modelo: SONNET, esforco: 'medium', maxTokens: 32000 },
  // Relatório de Produtividade
  'produtividade':   { modelo: HAIKU,  esforco: 'low',    maxTokens: 16000 }
};
const PERFIL_PADRAO = { modelo: SONNET, esforco: 'medium', maxTokens: 32000 };
const avisados = new Set();   // variável de perfil inválida: log uma vez

function perfil(tarefa) {
  const base = Object.assign({}, PERFIS[tarefa] || PERFIL_PADRAO);
  const nomeVar = 'IA_PERFIL_' + String(tarefa || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const v = String(process.env[nomeVar] || '').trim();
  if (v) {
    const [modelo, esforco] = v.split(':').map(s => s.trim());
    if (/^claude-[a-z0-9.-]+$/.test(modelo || '') && (!esforco || ESFORCOS.includes(esforco))) {
      base.modelo = modelo;
      if (esforco) base.esforco = esforco;
    } else if (!avisados.has(nomeVar)) {
      avisados.add(nomeVar);
      console.error(`claude: ${nomeVar}="${v}" ignorada (use modelo:esforço, ex. claude-sonnet-5-5:medium)`);
    }
  }
  return base;
}

// Preço de tabela em USD por 1 milhão de tokens: [entrada, saída]. Serve para o log de
// consumo e o teto diário (limite-ia.js) — errar aqui não quebra nada, só a estimativa.
// Cache: gravar custa 1,25× a entrada; reler custa 5% (Opus/Sonnet) ou 10% (Haiku).
const PRECOS = {
  'claude-fable-5-1':  [10.00, 50.00],
  'claude-opus-5-5':   [4.00, 20.00],
  'claude-sonnet-5-5': [2.00, 10.00],
  'claude-haiku-5-5':  [0.10, 0.50]
};
const HAIKU_LONGO = [0.50, 2.50];          // Haiku 5.5 com pedido acima de 100 mil tokens
const LEITURA_CACHE = { 'claude-haiku-5-5': 0.10 };
const PRECO_BUSCA = 0.01;                  // busca na web: US$ 10 por mil buscas

// Modelo sem preço na tabela: vale o do Opus (errar para mais é melhor que esconder gasto).
function custoUsd(modelo, entrada, saida, cacheEscrita = 0, cacheLeitura = 0, buscas = 0) {
  const total = (entrada || 0) + (cacheEscrita || 0) + (cacheLeitura || 0);
  let p = PRECOS[modelo] || PRECOS[OPUS];
  if (modelo === HAIKU && total > 100000) p = HAIKU_LONGO;
  const leitura = LEITURA_CACHE[modelo] || 0.05;
  return ((entrada || 0) * p[0] + (cacheEscrita || 0) * p[0] * 1.25 + (cacheLeitura || 0) * p[0] * leitura +
    (saida || 0) * p[1]) / 1e6 + (buscas || 0) * PRECO_BUSCA;
}

function chave() {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error('ANTHROPIC_API_KEY não configurada nas variáveis do serviço');
  return k;
}

// Sem timeout explícito uma chamada pendurada trava o serviço (uma réplica só, dividida com
// o /protocolo do balcão). A minuta no Opus com esforço alto pode passar de 3 min.
const TIMEOUT_MS = Number(process.env.IA_TIMEOUT_MS) || 600000;

let cliente = null;
function obterCliente() {
  if (!cliente) {
    const Anthropic = require('@anthropic-ai/sdk');
    // maxRetries: o SDK insiste sozinho em 429/5xx/529 (sobrecarga), respeitando retry-after.
    cliente = new Anthropic({ apiKey: chave(), timeout: TIMEOUT_MS, maxRetries: 3 });
  }
  return cliente;
}
// Só para os testes: troca o cliente por um falso (null volta ao real).
function _definirCliente(c) { cliente = c; }

// O erro mais perigoso deste sistema seria uma minuta cortada no meio que parece pronta.
// A API avisa pelo stop_reason quando estourou o limite de saída; aqui isso vira erro,
// nunca um texto salvo pela metade.
function exigirCompleto(r, oQue) {
  if (r.finish === 'max_tokens') {
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

// A Claude lê foto (JPG, PNG, WebP, GIF) e PDF direto. HEIC/HEIF (foto de iPhone) ela não
// lê: esses arquivos ficam fora do pedido (no Hub, o texto do OCR deles continua indo).
const MIMES_IMAGEM = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const ehHeic = mime => /^image\/hei[cf]$/i.test(String(mime || ''));
function blocosDeArquivos(arquivos = []) {
  const blocos = [];
  for (const a of arquivos) {
    if (!a || !a.base64 || !a.mime) continue;
    const mime = String(a.mime).toLowerCase();
    if (mime === 'application/pdf') {
      blocos.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.base64 } });
    } else if (MIMES_IMAGEM.has(mime)) {
      blocos.push({ type: 'image', source: { type: 'base64', media_type: mime, data: a.base64 } });
    }
  }
  return blocos;
}

// Busca na web (agente com usa_busca): ferramenta de servidor da própria Claude.
function ferramentaBusca() {
  return { type: process.env.IA_BUSCA_FERRAMENTA || 'web_search_20250305', name: 'web_search', max_uses: 5 };
}

// Erro do provedor → mensagem que o Hub sabe tratar (hub.js ehSobrecarga/ehCota e o
// RE_RECADO do agentes.js), sem despejar o JSON cru na tela.
function traduzirErro(e, modelo) {
  const nome = (e && (e.constructor && e.constructor.name)) || '';
  if (/Timeout/i.test(nome) || (e && e.name === 'AbortError')) {
    return new Error(`o modelo não respondeu em ${Math.round(TIMEOUT_MS / 1000)}s — tente de novo`);
  }
  const status = e && e.status;
  const detalhe = String((e && e.message) || e).slice(0, 400);
  if (status) {
    const err = new Error(`Claude ${modelo} ${status}${status === 529 ? ' overloaded' : ''}: ${detalhe}`);
    err.statusProvedor = status;
    return err;
  }
  return e instanceof Error ? e : new Error(detalhe);
}

async function chamar({ tarefa, sistema, partes, esquema = null, busca = false, codigo = null }) {
  const p = perfil(tarefa);
  const modelo = p.modelo;
  // v1.39.3 (segurança, pacote C): a regra "dado nunca é instrução" vai no fim do prompt de
  // sistema de TODA chamada — inclusive dos agentes que o Tabelião edita no banco. Ela vai
  // num bloco separado: o código muda a cada pedido e não pode invalidar o cache do prompt.
  const blocoPrompt = { type: 'text', text: String(sistema || '') || '(sem instruções adicionais)' };
  if (p.cache) blocoPrompt.cache_control = { type: 'ephemeral' };
  const corpo = {
    model: modelo,
    max_tokens: p.maxTokens,
    system: [blocoPrompt, { type: 'text', text: require('./ia-defesa').regraComCodigo(codigo) }],
    messages: [{ role: 'user', content: partes }],
    output_config: { effort: p.esforco }
  };
  if (esquema) corpo.output_config.format = { type: 'json_schema', schema: esquema };
  if (busca && !esquema) corpo.tools = [ferramentaBusca()];

  const cli = obterCliente();
  const pedir = c => cli.messages.stream(c).finalMessage();
  let msg;
  try {
    try { msg = await pedir(corpo); }
    catch (e) {
      // Esquema JSON recusado pela API (400): segue sem ele — o prompt já pede o JSON e o
      // servidor confere a forma depois. Melhor que derrubar a ferramenta.
      if (!esquema || !e || e.status !== 400) throw e;
      console.error(`claude ${tarefa}: esquema JSON recusado (${String(e.message).slice(0, 160)}) — sem esquema`);
      delete corpo.output_config.format;
      msg = await pedir(corpo);
    }
    // Busca na web longa: a API pode pausar o turno (pause_turn); devolve e continua.
    for (let i = 0; msg && msg.stop_reason === 'pause_turn' && i < 3; i++) {
      corpo.messages = [corpo.messages[0], { role: 'assistant', content: msg.content }];
      msg = await pedir(corpo);
    }
  } catch (e) { throw traduzirErro(e, modelo); }

  if (msg.stop_reason === 'refusal') throw new Error('o modelo bloqueou a requisição (recusa de segurança)');

  const texto = (msg.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('').trim();
  const u = msg.usage || {};
  const entrada = u.input_tokens || 0, escrita = u.cache_creation_input_tokens || 0, leitura = u.cache_read_input_tokens || 0;
  const saida = u.output_tokens || 0;
  const buscas = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
  return {
    texto,
    modelo: msg.model || modelo,
    esforco: p.esforco,
    tokens_entrada: entrada + escrita + leitura,
    tokens_saida: saida,
    tokens_cache_lidos: leitura,
    custo_usd: custoUsd(modelo, entrada, saida, escrita, leitura, buscas),
    finish: msg.stop_reason || null
  };
}

// JSON do modelo: tira cercas de markdown e o que vier fora do primeiro "{" … último "}".
function lerJson(texto) {
  try { return JSON.parse(texto); } catch (_) { /* segue */ }
  const m = String(texto || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('a extração não devolveu JSON válido');
  return JSON.parse(m[0]);
}

// Esquema da extração: um campo texto por campo do agente + _alertas (todos obrigatórios).
function esquemaExtracao(campos) {
  const props = {}, req = [];
  for (const c of campos) {
    if (!c || !c.id || props[c.id]) continue;
    props[c.id] = { type: 'string' };
    req.push(c.id);
  }
  props._alertas = { type: 'array', items: { type: 'string' } };
  req.push('_alertas');
  return { type: 'object', properties: props, required: req, additionalProperties: false };
}

// ---------------------------------------------------------------- ETAPA 1
// Extração: documentos (PDF/imagem) → JSON com os campos do ato.
// A usuária confere o JSON na tela antes de redigir.
async function extrair({ agente, arquivos, observacoes, fonte, manifestos = [] }) {
  const campos = Array.isArray(agente.campos) ? agente.campos : [];
  const esquemaTexto = campos.map(c =>
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
    esquemaTexto || '(nenhum campo declarado — devolva tudo que conseguir identificar)',
    fonte ? fonteContrato.REGRA_FONTE + '\nAlém dos campos e _alertas, inclua _fonte_decisoes seguindo: ' + fonteContrato.FORMATO_DECISOES : ''
  ].join('\n');

  const partes = [
    ...blocosDeArquivos(arquivos),
    ...(fonte ? [{ type: 'text', text: fonteContrato.contextoFonte(fonte, manifestos) }] : []),
    { type: 'text', text: observacoes
        ? `Observações da escrevente sobre este caso:\n${observacoes}\n\nExtraia os campos.`
        : 'Extraia os campos dos documentos acima.' }
  ];

  // Esquema JSON garantido quando há campos declarados e não há fonte (a matriz da fonte
  // tem valor_documento de tipo livre, que o esquema estrito não expressa).
  const esquema = campos.length && !fonte ? esquemaExtracao(campos) : null;
  const r = await chamar({ tarefa: 'agente-extrair', sistema, partes, esquema });
  if (r.finish === 'max_tokens') exigirCompleto(r, 'a extração');
  return { dados: lerJson(r.texto), uso: r };
}

// ---------------------------------------------------------------- ETAPA 2
// Redação: JSON conferido + template do ato → minuta completa.
async function redigir({ agente, dados, observacoes, fonte, manifestos = [], conferencia = [] }) {
  const sistema = [
    agente.prompt_sistema,
    agente.template ? '\n\n===== TEMPLATE VIGENTE DO ATO (siga a estrutura e as cláusulas condicionais) =====\n' + agente.template : '',
    fonte ? '\n' + fonteIA.instrucaoSaida() : ''
  ].join('');

  const partes = [{ type: 'text', text: [
    fonte ? fonteContrato.contextoFonte(fonte, manifestos, conferencia) : '',
    'DADOS COMPLEMENTARES CONFERIDOS PELA ESCREVENTE (não substituem silenciosamente a fonte autenticada e a documentação):',
    '```json',
    JSON.stringify(dados, null, 2),
    '```',
    observacoes ? `\nOBSERVAÇÕES DA ESCREVENTE:\n${observacoes}` : '',
    '',
    'Redija a minuta completa, pronta para o livro, no padrão do CN2O.',
    'Todo dado marcado "[VERIFICAR]" deve aparecer na minuta como [VERIFICAR] — jamais preenchido por conta própria.',
    'Não escreva preâmbulo nem comentário: comece direto pelo texto da escritura.'
  ].join('\n') }];

  const r = exigirCompleto(await chamar({ tarefa: 'agente-redigir', sistema, partes }), 'a minuta');
  return { texto: r.texto, uso: r };
}

// ---------------------------------------------------------------- ETAPA 3
// Revisão: minuta + pedido de ajuste → minuta corrigida por inteiro.
async function revisar({ agente, minutaAtual, pedido, historico = [], fonte, manifestos = [], conferencia = [] }) {
  const sistema = [
    agente.prompt_sistema,
    agente.template ? '\n\n===== TEMPLATE VIGENTE DO ATO =====\n' + agente.template : '',
    '\n\n===== MODO REVISÃO =====',
    'Você está revisando uma minuta já redigida. Aplique EXATAMENTE o ajuste pedido.',
    'Devolva a MINUTA INTEIRA corrigida, do começo ao fim — nunca só o trecho alterado,',
    'nunca um diff, nunca "restante inalterado". Sem preâmbulo e sem comentário final.',
    fonte ? '\n' + fonteIA.instrucaoSaida() : ''
  ].join('');

  const contexto = historico.length
    ? '\n\nAJUSTES JÁ PEDIDOS NESTA MINUTA:\n' + historico.map((h, i) => `${i + 1}. ${h}`).join('\n')
    : '';

  const partes = [{ type: 'text', text: [
    fonte ? fonteContrato.contextoFonte(fonte, manifestos, conferencia) : '',
    'MINUTA ATUAL:', '---', minutaAtual, '---',
    contexto,
    '', 'AJUSTE PEDIDO AGORA:', pedido,
    '', 'Devolva a minuta inteira já corrigida.'
  ].join('\n') }];

  const r = exigirCompleto(await chamar({ tarefa: 'agente-revisar', sistema, partes }), 'a revisão da minuta');
  return { texto: r.texto, uso: r };
}

// ------------------------------------------------------- ETAPA ÚNICA
// Ferramentas e comunicação não são escrituras: não têm template, não passam por
// conferência de JSON e não viram minuta em três turnos. Entra documento ou
// formulário, sai texto. Uma chamada só. `tarefa` escolhe o perfil (modelo + esforço);
// `esquema` (opcional) garante a resposta em JSON nesse formato.
async function executar({ agente, arquivos = [], campos = {}, observacoes, tarefa = 'agente-executar', esquema = null, codigo = null }) {
  const preenchidos = Object.entries(campos)
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k, v]) => `${k}: ${v}`);

  // Os documentos vêm ANTES das instruções: com material longo o modelo ancora
  // melhor a transcrição literal assim (é a nota de implantação do próprio
  // Not-Extrator, e vale para qualquer agente que transcreva).
  const partes = [
    ...blocosDeArquivos(arquivos),
    { type: 'text', text: [
        preenchidos.length ? 'DADOS INFORMADOS:\n' + preenchidos.join('\n') : '',
        observacoes ? `\nOBSERVAÇÕES:\n${observacoes}` : '',
        arquivos.length ? '\nOs documentos acima fazem parte do pedido.' : '',
        '\nExecute a sua função sobre o material acima, no formato de saída que as',
        'suas instruções definem. Responda apenas com o resultado — sem preâmbulo,',
        'sem "segue abaixo", sem comentário final.'
      ].filter(Boolean).join('\n') }
  ];

  const r = exigirCompleto(await chamar({
    tarefa, sistema: agente.prompt_sistema, partes, esquema,
    busca: !!agente.usa_busca,
    codigo   // v1.39.3: código dos blocos de dados deste pedido (ia-defesa.js)
  }), 'a resposta');
  return { texto: r.texto, uso: r };
}

// Tabela de perfis vigente (com as trocas por variável), para a tela do Tabelião.
function perfisVigentes() {
  return Object.keys(PERFIS).map(t => Object.assign({ tarefa: t }, perfil(t), { preco_usd_mtok: PRECOS[perfil(t).modelo] || null }));
}

module.exports = {
  extrair, redigir, revisar, executar, custoUsd, perfil, perfisVigentes, ehHeic, blocosDeArquivos,
  esquemaExtracao, PERFIS, PRECOS, OPUS, SONNET, HAIKU, _definirCliente
};
