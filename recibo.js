// recibo.js — as variáveis do recibo de protocolo enviado por WhatsApp.
// -----------------------------------------------------------------------------
// Template novo: recibo_protocolo_3 (pt_BR, Utilidade), com CINCO variáveis.
//
// ATENÇÃO: a ordem abaixo é a do texto APROVADO NA META. Se ela for alterada
// aqui sem cadastrar um template novo, o cliente recebe os dados trocados e a
// Meta NÃO acusa erro nenhum (a quantidade de parâmetros continua batendo).
//   {{1}} data e hora do protocolo (fuso de Sergipe)
//   {{2}} tipo de ato por extenso
//   {{3}} parte / comprador(a)
//   {{4}} apresentante
//   {{5}} número do protocolo
//
// PORTA DE TROCA SEM PARADA: o WhatsApp recusa a mensagem inteira quando o número
// de parâmetros não bate com o do template aprovado (erro 132000). Por isso a
// quantidade de variáveis segue o NOME do template configurado. Enquanto
// WHATS_TEMPLATE_RECIBO apontar para o recibo_protocolo_2, sai o recibo antigo
// (uma variável: só o número do protocolo). A virada é uma linha na Railway.
//
// A Meta também recusa parâmetro vazio, com quebra de linha, com tabulação ou com
// mais de quatro espaços seguidos: `campo()` normaliza tudo isso e, na falta do
// dado, põe um texto de reserva em vez de deixar o recibo falhar no balcão.
const { NOMES_ATO } = require('./atos');

const LIMITE_PARAMETRO = 180;          // a Meta corta parâmetros muito longos
const VARIAVEIS_POR_TEMPLATE = {
  'recibo_protocolo': 1,               // caso configurado sem sufixo
  'recibo_protocolo_1': 1,
  'recibo_protocolo_2': 1,             // só o número — texto antigo
  'recibo_protocolo_3': 5              // data, ato, parte, apresentante, número
};
const PADRAO_VARIAVEIS = 1;
const FUSO_CARTORIO = 'America/Maceio'; // Alagoas e Sergipe (UTC-3); a Railway roda em UTC

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

// Data e hora no formato do recibo impresso: "18/09/2026, 17:46:32".
// O recibo é disparado no momento do protocolo, então a hora do envio é a hora
// do protocolo. Se o objeto do protocolo passar a guardar a data/hora, use o
// campo dele aqui no lugar de new Date().
function dataHoraDoProtocolo() {
  return new Date().toLocaleString('pt-BR', { timeZone: FUSO_CARTORIO });
}

function variaveisDoRecibo(p, numero, nomeTemplate) {
  // Templates de uma variável (recibo_protocolo_2): só o número do protocolo.
  if (quantasVariaveis(nomeTemplate) === 1) return [campo(numero)];

  const q = p || {};
  // Suporte amplo a compra e venda, cessões (CDP/CDH) e outros atos
  const nomeParte = (q.parte_envolvida && q.parte_envolvida.nome) ||
                    (q.cessionario && q.cessionario.nome) ||
                    (q.comprador && q.comprador.nome);

  // recibo_protocolo_3 — mesma ordem do texto aprovado na Meta:
  //   Data e hora: {{1}} | Ato: {{2}} | Comprador(a): {{3}} | Apresentante: {{4}} | Nº do protocolo: {{5}}
  return [
    campo(dataHoraDoProtocolo()),
    campo(NOMES_ATO[q.ato] || q.ato),
    campo(nomeParte),
    campo(q.apresentante && q.apresentante.nome),
    campo(numero)
  ];
}

module.exports = { variaveisDoRecibo, campo, quantasVariaveis, LIMITE_PARAMETRO, VARIAVEIS_POR_TEMPLATE };
