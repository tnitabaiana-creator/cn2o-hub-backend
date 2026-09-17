// recibo.js — as variáveis do recibo de protocolo enviado por WhatsApp.
// -----------------------------------------------------------------------------
// Template novo: recibo_protocolo_3 (pt_BR, Utilidade), com CINCO variáveis, na
// mesma ordem em que o extrato do T-Consulta apresenta os fatos — que é o padrão
// da casa:
//   {{1}} número do protocolo (o template o imprime em negrito)
//   {{2}} tipo de ato por extenso
//   {{3}} apresentante
//   {{4}} parte / comprador(a)
//   {{5}} vendedor(a) / transmitente
//
// PORTA DE TROCA SEM PARADA: o WhatsApp recusa a mensagem inteira quando o número
// de parâmetros não bate com o do template aprovado (erro 132000). Por isso a
// quantidade de variáveis segue o NOME do template configurado. Enquanto a Meta
// não aprovar o recibo_protocolo_3, WHATS_TEMPLATE_RECIBO continua apontando para
// o recibo_protocolo_2 e o recibo antigo (de uma variável) segue saindo normal.
// A virada é uma linha só na Railway — nenhum código muda.
//
// A Meta também recusa parâmetro vazio, com quebra de linha, com tabulação ou com
// mais de quatro espaços seguidos: `campo()` normaliza tudo isso e, na falta do
// dado, põe um texto de reserva em vez de deixar o recibo falhar no balcão.
const { NOMES_ATO } = require('./atos');

const LIMITE_PARAMETRO = 180;          // a Meta corta parâmetros muito longos
const VARIAVEIS_POR_TEMPLATE = {
  'recibo_protocolo': 1,               // caso configurado sem sufixo
  'recibo_protocolo_1': 1,
  'recibo_protocolo_2': 1,             // só o número — aprovado na Meta
  'recibo_protocolo_3': 5              // o padrão do extrato (5 variáveis)
};
const PADRAO_VARIAVEIS = 1;

function campo(valor, reserva) {
  // A Meta recusa parâmetro com quebras de linha, tabulação ou espaços consecutivos
  const s = String(valor == null ? '' : valor)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!s) return reserva || 'não informado';
  return s.length > LIMITE_PARAMETRO ? s.slice(0, LIMITE_PARAMETRO - 1).trim() + '…' : s;
}

function quantasVariaveis(nomeTemplate) {
  if (process.env.WHATS_VARIAVEIS_QTD) {
    const q = parseInt(process.env.WHATS_VARIAVEIS_QTD, 10);
    if (!isNaN(q) && q > 0) return q;
  }
  const nome = String(nomeTemplate == null ? (process.env.WHATS_TEMPLATE_RECIBO || 'recibo_protocolo_2') : nomeTemplate).trim();
  const n = VARIAVEIS_POR_TEMPLATE[nome];
  return n === undefined ? (nome.includes('3') ? 5 : PADRAO_VARIAVEIS) : n;
}

function variaveisDoRecibo(p, numero, nomeTemplate) {
  const q = p || {};
  // Suporte amplo a compra e venda, cessões (CDP/CDH) e outros atos
  const nomeParte = (q.parte_envolvida && q.parte_envolvida.nome) ||
                    (q.cessionario && q.cessionario.nome) ||
                    (q.comprador && q.comprador.nome);
  const nomeOutro = (q.vendedor && q.vendedor.nome) ||
                    (q.cedente && q.cedente.nome);

  const completas = [
    campo(numero),
    campo(NOMES_ATO[q.ato] || q.ato),
    campo(q.apresentante && q.apresentante.nome),
    campo(nomeParte),
    campo(nomeOutro, 'não se aplica')
  ];
  return completas.slice(0, quantasVariaveis(nomeTemplate));
}

module.exports = { variaveisDoRecibo, campo, quantasVariaveis, LIMITE_PARAMETRO, VARIAVEIS_POR_TEMPLATE };
