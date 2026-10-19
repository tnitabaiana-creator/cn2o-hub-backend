// triagem.js — v1.51: o Haiku escolhe modelo e esforço caso a caso (escrituras e leitura de documentos).
//
// Antes da análise principal, o servidor calcula SINAIS do caso — só contagens e marcas, nunca nome,
// CPF ou trecho de documento — e decide um DEGRAU da escada abaixo, dentro da faixa da ferramenta:
//   1) regras dão a nota (0–100); nota < 25 ou > 75 decide ali mesmo, de graça;
//   2) na faixa do meio, o Haiku (esforço baixo, JSON garantido) lê os sinais e decide;
//   3) travas: confiança baixa sobe um degrau; nunca abaixo do piso nem acima do teto.
// Modos (IA_TRIAGEM no Railway): "sombra" (padrão — a triagem roda em paralelo e só é gravada; a
// análise usa o perfil fixo), "ativa" (a triagem decide; resposta truncada ou JSON inválido refaz um
// degrau acima, uma vez) e "desligada". IA_PERFIL_<TAREFA> fixado pelo Tabelião vence a triagem.
'use strict';

const claude = require('./claude');
const defesa = require('./ia-defesa');

const DEGRAUS = [null,
  { modelo: claude.HAIKU,  esforco: 'low' },
  { modelo: claude.HAIKU,  esforco: 'medium' },
  { modelo: claude.SONNET, esforco: 'low' },
  { modelo: claude.SONNET, esforco: 'medium' },
  { modelo: claude.SONNET, esforco: 'high' },
  { modelo: claude.OPUS,   esforco: 'medium' },
  { modelo: claude.OPUS,   esforco: 'high' }
];
const NOME_DEGRAU = d => d && DEGRAUS[d] ? DEGRAUS[d].modelo.replace(/^claude-|-\d+-\d+$/g, '') + ' · ' + DEGRAUS[d].esforco : '';
// tarefa → [piso, teto]. Fora daqui (redator, transpor, descrição, produtividade) vale o perfil fixo.
const FAIXAS = {
  'minuta': [4, 7], 'minuta_ue': [4, 7], 'agente-redigir': [4, 7], 'agente-revisar': [4, 7],
  'matricula': [4, 7], 'itcmd': [4, 6], 'qualificacao': [3, 5], 'agente-extrair': [3, 5]
};
const TIMEOUT_TRIAGEM_MS = Number(process.env.IA_TRIAGEM_TIMEOUT_MS) || 20000;

function modo() {
  const v = String(process.env.IA_TRIAGEM || 'sombra').trim().toLowerCase();
  return ['sombra', 'ativa', 'desligada'].includes(v) ? v : 'sombra';
}
function emEscopo(tarefa) {
  return modo() !== 'desligada' && Object.prototype.hasOwnProperty.call(FAIXAS, tarefa) && !claude.perfilFixado(tarefa);
}
const limitar = (d, [piso, teto]) => Math.max(piso, Math.min(teto, Math.round(d)));
function degrauDe(modelo, esforco) {
  const i = DEGRAUS.findIndex(x => x && x.modelo === modelo && x.esforco === esforco);
  return i > 0 ? i : null;
}
function perfilDoDegrau(d) { return DEGRAUS[d] ? Object.assign({}, DEGRAUS[d]) : null; }

// ---------------------------------------------------------------- sinais (sem dado pessoal)
const RE_CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const RE_CNPJ = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;
const RE_REGISTRO = /\b(R|AV)[.\-\s]{0,2}(\d{1,3})\b/g;
const MARCAS = {
  rural: /\b(CCIR|SIGEF|INCRA|ITR|NIRF|im[óo]vel rural|propriedade rural|hectares?)\b|\bCAR\b/i,
  menor_incapaz: /\b(menor(es)? (de idade|impúbere|púbere)|incapaz|curatela|curador|tutela|tutor)\b/i,
  espolio: /\b(esp[óo]lio|falecid[oa]|de cujus|inventari|partilha|herdeir|[óo]bito)/i,
  usufruto: /\busufrut/i,
  cessao: /\bcess(ão|ao|ion[áa]ri)/i,
  procuracao: /\b(procura[çc][ãa]o|procurador|mandat[áa]ri)/i,
  pj: /\b(LTDA|S\.?\/?A\.?|EIRELI|CNPJ|sociedade|empresa)\b/i,
  divergencia: /\bdiverg[êe]n/i
};
const ATO_COMPLEXO = /invent|partilh|cumulat|cess|cdh|divis|usucap|hipotec|fiduci|permut|dação|dacao|integraliz|incorpora/i;
const ATO_SIMPLES = /procura|ata notarial|declarat|reconhec|revoga|substabelec|testamento/i;

function sinaisDoPedido({ tarefa, ato, texto = '', arquivos = [], ocrResumo = null, ocrTexto = '', fonte = null, dados = null, minutaAtual = '', historico = [] }) {
  const corpo = [texto, ocrTexto, dados ? JSON.stringify(dados) : '', minutaAtual].join('\n');
  const mAto = /^[ \t]*ATO:[ \t]*([^\n]{1,40})/m.exec(texto || '');
  const atoNome = String((fonte && fonte.protocolo && fonte.protocolo.ato) || (mAto && mAto[1]) || ato || '')
    .toLowerCase().replace(/[^a-z0-9à-ú _\-/]/gi, '').trim().slice(0, 40);
  const distintos = re => new Set((corpo.match(re) || []).map(x => x.replace(/\D/g, ''))).size;
  const registros = new Set(); let m;
  RE_REGISTRO.lastIndex = 0;
  while ((m = RE_REGISTRO.exec(corpo))) registros.add(m[1].toUpperCase() + m[2]);
  const pdfs = arquivos.filter(a => /pdf/i.test(a && a.mime)).length;
  const bytes = arquivos.reduce((t, a) => t + Math.floor(String((a && a.base64) || '').length * 0.75), 0);
  const marcas = {};
  for (const [k, re] of Object.entries(MARCAS)) marcas[k] = re.test(corpo);
  const r = ocrResumo && ocrResumo.ativo ? ocrResumo : null;
  const curadoria = fonte && fonte.curadoria ? String(fonte.curadoria.estado || '') : '';
  return {
    tarefa,
    ato: atoNome,
    arquivos: arquivos.length, pdfs, imagens: arquivos.length - pdfs,
    mb: Math.round(bytes / 1e5) / 10,
    paginas: r ? r.paginas || 0 : null,
    ocr_incerto_pct: r && r.palavras_lidas ? Math.round(1000 * r.palavras_incertas / r.palavras_lidas) / 10 : null,
    caracteres: corpo.length,
    cpfs: distintos(RE_CPF),
    cnpjs: distintos(RE_CNPJ),
    registros_matricula: registros.size,
    onus: defesa.ONUS.filter(([, re]) => re.test(corpo)).map(([nome]) => nome),
    marcas,
    com_protocolo: !!fonte,
    curadoria: curadoria || null,
    minuta_caracteres: minutaAtual ? String(minutaAtual).length : 0,
    ajustes: Array.isArray(historico) ? historico.length : 0
  };
}

// ---------------------------------------------------------------- nota por regras
// Pesos iniciais — a calibração das duas semanas em modo sombra ajusta isto com dados reais.
function notaPorRegras(s) {
  const motivos = [];
  let n = 0;
  const soma = (pts, motivo) => { if (pts > 0.5) motivos.push(motivo); n += pts; };
  soma(Math.min(18, s.arquivos * 2.5), s.arquivos + ' arquivo(s)');
  if (s.paginas) soma(Math.min(14, s.paginas * 0.7), s.paginas + ' página(s)');
  soma(Math.min(10, s.caracteres / 20000), Math.round(s.caracteres / 1000) + ' mil caracteres');
  soma(Math.min(10, Math.max(0, s.cpfs - 2) * 2.5), s.cpfs + ' CPF(s)');
  soma(Math.min(10, s.registros_matricula * 0.8), s.registros_matricula + ' registro(s)/averbação(ões)');
  soma(Math.min(15, s.onus.length * 5), 'ônus: ' + s.onus.join(', '));
  const mk = s.marcas || {};
  if (mk.rural) soma(8, 'rural');
  if (mk.menor_incapaz) soma(10, 'menor/incapaz');
  if (mk.espolio) soma(8, 'espólio/sucessão');
  if (mk.usufruto) soma(4, 'usufruto');
  if (mk.cessao) soma(6, 'cessão');
  if (mk.pj || s.cnpjs) soma(4, 'pessoa jurídica');
  if (mk.procuracao) soma(3, 'representação');
  if (mk.divergencia || /divergent|nao_conferid/.test(s.curadoria || '')) soma(8, 'divergência/curadoria');
  if (s.ocr_incerto_pct != null) soma(s.ocr_incerto_pct > 10 ? 6 : s.ocr_incerto_pct > 5 ? 3 : 0, 'OCR difícil (' + s.ocr_incerto_pct + '%)');
  if (ATO_COMPLEXO.test(s.ato)) soma(10, 'ato complexo (' + s.ato + ')');
  else if (ATO_SIMPLES.test(s.ato)) { n -= 6; motivos.push('ato simples (' + s.ato + ')'); }
  if (s.ajustes) soma(Math.min(8, s.ajustes * 2), s.ajustes + ' ajuste(s) já pedido(s)');
  if (s.minuta_caracteres) soma(Math.min(6, s.minuta_caracteres / 6000), 'minuta longa');
  return { nota: Math.max(0, Math.min(100, Math.round(n))), motivos };
}
const degrauDaNota = (nota, faixa) => limitar(faixa[0] + (nota / 100) * (faixa[1] - faixa[0]), faixa);

// ---------------------------------------------------------------- Haiku
const PROMPT_TRIAGEM = [
  'Você é a TRIAGEM DE COMPLEXIDADE do Hub do Cartório de Notas do 2º Ofício de Itabaiana/SE (CN2O).',
  'Recebe só SINAIS de um caso (contagens e marcas, sem dados pessoais) e a faixa de degraus permitida para a ferramenta.',
  'Escolha o degrau MAIS BARATO que dê conta do caso com segurança jurídica. Degraus: 1 Haiku baixo · 2 Haiku médio · 3 Sonnet baixo ·',
  '4 Sonnet médio · 5 Sonnet alto · 6 Opus médio · 7 Opus alto.',
  'Pedem degrau alto: sucessão/espólio, inventário cumulativo, menor ou incapaz, rural (CCIR/SIGEF/CAR), vários ônus,',
  'matrícula com muitos registros, muitas partes, pessoa jurídica, cessão, divergência na curadoria, OCR difícil, muitos documentos.',
  'Pedem degrau baixo: ato simples, poucas partes, poucos documentos, sem ônus nem marcas.',
  'Na dúvida entre dois degraus, prefira o mais alto e diga confianca "baixa". Responda só o JSON.'
].join('\n');
function esquemaTriagem(faixa) {
  const permitidos = []; for (let d = faixa[0]; d <= faixa[1]; d++) permitidos.push(d);
  return { type: 'object', additionalProperties: false, required: ['score', 'degrau', 'confianca', 'motivo'], properties: {
    score: { type: 'integer' }, degrau: { type: 'integer', enum: permitidos },
    confianca: { type: 'string', enum: ['alta', 'media', 'baixa'] }, motivo: { type: 'string' } } };
}
function comPrazo(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('triagem sem resposta em ' + ms / 1000 + 's')), ms); })])
    .finally(() => clearTimeout(t));
}

// → { score, degrau, modelo, esforco, origem: regra|haiku|falha, confianca, motivo, custo_usd, uso }
async function decidir({ tarefa, sinais, codigo }) {
  const faixa = FAIXAS[tarefa];
  const { nota, motivos } = notaPorRegras(sinais);
  const base = { score: nota, custo_usd: 0, uso: null };
  if (nota < 25 || nota > 75) {
    const d = degrauDaNota(nota, faixa);
    return Object.assign(base, { degrau: d, origem: 'regra', confianca: 'alta', motivo: 'regras: ' + (motivos.slice(0, 6).join('; ') || 'caso simples') }, perfilDoDegrau(d));
  }
  const pedido = { ferramenta: tarefa, faixa_permitida: { piso: faixa[0], teto: faixa[1], nomes: Object.fromEntries([faixa[0], faixa[1]].map(d => [d, NOME_DEGRAU(d)])) },
    nota_das_regras: nota, sinais };
  try {
    const r = await comPrazo(claude.executar({
      agente: { prompt_sistema: PROMPT_TRIAGEM },
      observacoes: defesa.blocoDados('SINAIS DO CASO', JSON.stringify(pedido), codigo || defesa.novoCodigo()),
      tarefa: 'triagem', esquema: esquemaTriagem(faixa), codigo
    }), TIMEOUT_TRIAGEM_MS);
    const j = JSON.parse(String(r.texto).slice(String(r.texto).indexOf('{'), String(r.texto).lastIndexOf('}') + 1));
    let d = limitar(Number(j.degrau) || degrauDaNota(nota, faixa), faixa);
    const confianca = ['alta', 'media', 'baixa'].includes(j.confianca) ? j.confianca : 'baixa';
    if (confianca === 'baixa') d = limitar(d + 1, faixa);
    return Object.assign(base, { score: Number.isInteger(j.score) ? Math.max(0, Math.min(100, j.score)) : nota, degrau: d, origem: 'haiku', confianca,
      motivo: String(j.motivo || '').slice(0, 300), custo_usd: r.uso.custo_usd || 0, uso: r.uso }, perfilDoDegrau(d));
  } catch (e) {
    return Object.assign(base, { degrau: null, modelo: null, esforco: null, origem: 'falha', confianca: null, motivo: String(e.message || e).slice(0, 200) });
  }
}

// ---------------------------------------------------------------- volta da análise principal
// chamar(perfil|null) faz a análise (null = perfil fixo). classificar(resposta) → 'ok' | 'json_invalido' |
// estado da minuta. Grava a decisão e o resultado; na sombra, nada muda para o balcão.
async function comTriagem({ tarefa, login, sinais, codigo, chamar, classificar }) {
  if (!emEscopo(tarefa)) return chamar(null);
  const m = modo(), faixa = FAIXAS[tarefa], inicio = Date.now();
  const pTri = decidir({ tarefa, sinais, codigo });
  let tri = null, perfil = null;
  if (m === 'ativa') { tri = await pTri; perfil = tri.degrau ? perfilDoDegrau(tri.degrau) : null; }
  let r = null, erro = null, resultado = 'ok', degrauUsado = tri && tri.degrau;
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    erro = null;
    try {
      r = await chamar(perfil);
      resultado = classificar ? classificar(r) : 'ok';
    } catch (e) {
      erro = e;
      resultado = /excedeu o limite de saída/.test(String(e.message)) ? 'truncada' : /CONFERENCIA_INVALIDA|JSON|estruturad/i.test(String(e.codigo || e.message)) ? 'json_invalido' : 'erro';
    }
    const subir = m === 'ativa' && perfil && degrauUsado && degrauUsado < faixa[1] && (resultado === 'truncada' || resultado === 'json_invalido');
    if (!subir || tentativa === 1) break;
    // a tentativa descartada também custou: entra no consumo (e no teto diário)
    if (r && r.uso) require('./db-agentes').registrarConsumo({ minuta_id: null, usuario: login, agente: 'hub-' + tarefa, etapa: 'tentativa', uso: r.uso })
      .catch(e => console.error('triagem consumo:', e.message));
    degrauUsado += 1;
    perfil = perfilDoDegrau(degrauUsado);
    console.error(`triagem ${tarefa}: ${resultado} — refazendo um degrau acima (${NOME_DEGRAU(degrauUsado)})`);
  }
  if (!tri) tri = await pTri;
  registrar({ tarefa, login, modo: m, tri, sinais, uso: r && r.uso, resultado, ms: Date.now() - inicio });
  if (erro) throw erro;
  return r;
}

function registrar({ tarefa, login, modo: m, tri, sinais, uso, resultado, ms }) {
  try {
    const dba = require('./db-agentes');
    if (tri.uso) dba.registrarConsumo({ minuta_id: null, usuario: login, agente: 'hub-triagem', etapa: 'triagem', uso: tri.uso })
      .catch(e => console.error('triagem consumo:', e.message));
    const usado = uso ? degrauDe(uso.modelo, uso.esforco) : null;
    const custoReal = uso ? Number(uso.custo_usd) || 0 : 0;
    const precoUsado = uso && claude.PRECOS[uso.modelo], precoSug = tri.modelo && claude.PRECOS[tri.modelo];
    // estimativa: mesmos tokens no preço do modelo sugerido (todos têm saída = 5× a entrada)
    const custoEstimado = precoUsado && precoSug ? custoReal * precoSug[0] / precoUsado[0] : null;
    dba.registrarTriagem({
      usuario: login, ferramenta: tarefa, modo: m, origem: tri.origem, score: tri.score,
      degrau_sugerido: tri.degrau, modelo_sugerido: tri.modelo, esforco_sugerido: tri.esforco,
      degrau_usado: usado, modelo_usado: uso ? uso.modelo : null, esforco_usado: uso ? uso.esforco : null,
      confianca: tri.confianca, motivo: tri.motivo, sinais,
      custo_triagem_usd: tri.custo_usd || 0, custo_real_usd: custoReal, custo_estimado_usd: custoEstimado,
      tokens_entrada: uso ? uso.tokens_entrada || 0 : 0, tokens_saida: uso ? uso.tokens_saida || 0 : 0, resultado, ms
    }).catch(e => console.error('triagem registro:', e.message));
  } catch (e) { console.error('triagem registro:', e.message); }
}

// Estado do envelope da minuta ("Estado: PRONTA") — o resultado que a calibração compara.
function estadoDaMinuta(texto) {
  const m = /^[ \t]*(?:-[ \t]*)?Estado:[ \t]*([A-ZÀ-Ú_ ]{3,40})/m.exec(String(texto || ''));
  return m ? m[1].trim().toLowerCase().replace(/\s+/g, '_') : 'ok';
}

module.exports = { DEGRAUS, FAIXAS, NOME_DEGRAU, modo, emEscopo, sinaisDoPedido, notaPorRegras, degrauDaNota, decidir, comTriagem,
  perfilDoDegrau, degrauDe, estadoDaMinuta, esquemaTriagem, PROMPT_TRIAGEM };
