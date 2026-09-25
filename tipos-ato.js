// tipos-ato.js — "Tipo de Ato" canônico a partir do título do cartão.
//
// O campo personalizado "Tipo de Ato" não viaja com o cartão entre quadros, e os
// cartões anteriores ao e-Protocolo foram titulados à mão, cada um de um jeito:
//   "Prot. (CV-Urbano) 1400 - FULANO"          (e-Protocolo)
//   "Prot. (CDH)-1311 - Extra 1841"            "Prot. (DOA) -1308; Extra: 1801"
//   "Prot. (CV-Rural-Dr.Jessica) -1059"        "Prot. (Ata Transcrição de Áudio) -1224"
//   "Prot. (RERRATIF-MANOEL-ASSINA SEXTA 16H) -0980"
// Regra: vale o texto entre os primeiros parênteses (ou o título inteiro, se não
// houver); entre as regras que casam, ganha a que casa MAIS À ESQUERDA — o ato vem
// primeiro e o comentário depois ("CV - FALTA CERTIDÃO" é CV, não CERT). Empate:
// a ordem da lista (CV-Rural antes de CV-Urbano, ATA-W/A antes de ATA).
'use strict';

// código → [descrição, peso inicial, horas úteis de referência do custo pessoal].
// Peso e referência são o PONTO DE PARTIDA (CV-Urbano = 1): a tabela pesos_ato no
// banco é quem manda e o Tabelião calibra por lá. Enquanto a equipe não tiver 3
// conclusões de um tipo na janela, o relatório usa a referência daqui.
const TIPOS = {
  'CV-Urbano': ['Compra e Venda (urbano)', 1.0, 4],
  'CV-Rural':  ['Compra e Venda (rural)', 1.4, 6],
  'CDH':       ['Cessão de Direitos Hereditários', 1.5, 6],
  'CDP':       ['Cessão de Direitos Possessórios', 0.8, 3],
  'DOA':       ['Doação', 1.0, 4],
  'PER':       ['Permuta', 1.3, 5],
  'DAC':       ['Dação em Pagamento', 1.1, 4],
  'INV':       ['Inventário e Partilha', 2.5, 10],
  'TEST':      ['Testamento', 1.0, 3],
  'DIV':       ['Divórcio', 1.5, 6],
  'UE':        ['União Estável', 0.7, 2],
  'DUE':       ['Dissolução de União Estável', 1.0, 3],
  'RERRAT':    ['Re-ratificação', 0.6, 2],
  'ATA-U':     ['Ata de Usucapião', 2.5, 10],
  'ATA-W/A':   ['Ata de WhatsApp / Áudio', 0.8, 3],
  'ATA':       ['Ata Notarial (outras)', 0.8, 3],
  'PROC':      ['Procuração', 0.3, 1],
  'LAJE':      ['Direito Real de Laje', 1.2, 5],
  'CDRU':      ['Concessão de Direito Real de Uso', 1.2, 5],
  'CERT':      ['Certidão / Traslado', 0.2, 1],
  'OUTROS':    ['Outros / não identificado', 1.0, 4]
};

const REGRAS = [
  ['CV-Rural',  /\bCV\b.*RURAL|\bCV-?R\b|RURAL/],
  ['CV-Urbano', /\bCV\b|\bCV-?U\b|COMPRA|VENDA/],
  ['CDH',       /\bCDH\b|HEREDITAR/],
  ['CDP',       /\bCDP\b|POSSESSOR/],
  ['DAC',       /\bDAC\b|\bDACAO\b/],
  ['DOA',       /\bDOA\b|\bDOAC/],
  ['PER',       /\bPER\b|\bPERM/],
  ['INV',       /\bINV\b|INVENTAR|PARTILHA|ADJUDICA/],
  ['TEST',      /\bTEST\b|\bTESTAM/],
  ['DUE',       /\bDUE\b|DISSOLU|\bUE-?DIS/],
  ['UE',        /\bUE\b|UNIAO\s+ESTAVEL/],
  ['DIV',       /\bDIV\b|DIVORC/],
  ['RERRAT',    /RERRAT|RE-?RATIF|RETIFICA/],
  ['ATA-U',     /\bATA\b.*(USUCAP|\bUSO\b|\bU\b)|USUCAP/],
  ['ATA-W/A',   /\bATA\b.*(WHATS|\bZAP|AUDIO|W\/A|\bW\b|TRANSCRI|CONSTATA|DIGITAL|CELULAR)/],
  ['ATA',       /\bATA\b/],
  ['LAJE',      /\bLAJE\b/],
  ['CDRU',      /\bCDRU\b|DIREITO REAL DE USO/],
  ['PROC',      /\bPROC\b|PROCURA/],
  ['CERT',      /\bCERT\b|CERTID|TRASLADO/]
];

function semAcento(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

// Texto livre ("CV-Urbano", "TESTAMENTO-AMORIM", "Ata WhatsApp"…) → código canônico.
function normalizarTipoAto(texto) {
  const s = semAcento(texto).trim();
  if (!s) return 'OUTROS';
  for (const cod of Object.keys(TIPOS)) if (semAcento(cod) === s) return cod;
  let melhor = null;
  for (const [cod, re] of REGRAS) {
    const m = re.exec(s);
    if (m && (!melhor || m.index < melhor.idx)) melhor = { cod, idx: m.index };
  }
  return melhor ? melhor.cod : 'OUTROS';
}

// Título do cartão → { protocolo, tipo_ato, rotulo }. Protocolo: o número logo depois
// dos parênteses; na falta, a regra da casa (o PRIMEIRO número de 3 a 6 dígitos).
function extrairDoTitulo(titulo) {
  const t = String(titulo || '');
  const par = /\(([^)]*)\)/.exec(t);
  const rotulo = par ? par[1].trim() : t.replace(/^\s*prot\.?/i, '').trim();
  const depois = par ? /^\s*[-–—:;.]?\s*(\d{3,6})\b/.exec(t.slice(par.index + par[0].length)) : null;
  const primeiro = /\d{3,6}/.exec(par ? t.slice(par.index + par[0].length) : t);
  const n = depois ? depois[1] : (primeiro ? primeiro[0] : null);
  return { protocolo: n ? parseInt(n, 10) : null, tipo_ato: normalizarTipoAto(rotulo), rotulo };
}

module.exports = { TIPOS, normalizarTipoAto, extrairDoTitulo };
