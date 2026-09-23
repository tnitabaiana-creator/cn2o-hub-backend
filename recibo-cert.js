// recibo-cert.js — o recibo do WhatsApp para o pedido de CERTIDÃO / TRASLADO (v1.37.1).
// -----------------------------------------------------------------------------
// O recibo_protocolo_3 rotula a pessoa do ato como "Comprador(a)"; num pedido de
// certidão o cliente leria "Comprador(a): FULANO" (que pode ser o testador ou o
// falecido). Por isso o CERT tem template próprio, ligado pela variável
// WHATS_TEMPLATE_CERT na Railway (sem ela, o CERT continua saindo pelo recibo comum).
//
// TEXTO A CADASTRAR NA META (categoria Utilidade, idioma pt_BR, nome sugerido
// recibo_certidao_1) — a ordem das variáveis abaixo é a deste arquivo:
//
//   *CARTÓRIO DE NOTAS DO 2º OFÍCIO — ITABAIANA/SE*
//
//   Recibo de protocolo — {{1}}
//   Pedido: {{2}}
//   Solicitante: {{3}}
//   Ato procurado em nome de: {{4}}
//
//   *Nº do protocolo: {{5}}*
//
//   Guarde este número: use-o para acompanhar o seu pedido em cn2oita.com.br ou
//   informe-o à atendente do cartório.
//
//   {{1}} data e hora do protocolo (fuso de Sergipe)
//   {{2}} o que foi pedido (certidão em breve relatório, inteiro teor, traslado…)
//   {{3}} solicitante
//   {{4}} pessoa que participa do ato procurado
//   {{5}} número do protocolo
//
// Só o SOLICITANTE recebe este recibo (a pessoa do ato é terceiro — LGPD).
// `campo()` é o mesmo do recibo.js do Tabelião: normaliza espaços/quebras, corta
// em 180 caracteres e põe texto de reserva no lugar de dado vazio.
const { campo } = require('./recibo');

const FUSO_CARTORIO = 'America/Maceio';
const TEMPLATE_CERT_VARIAVEIS = 5;

function dataHoraDoProtocolo() {
  return new Date().toLocaleString('pt-BR', { timeZone: FUSO_CARTORIO });
}

// Nome do template do CERT: só existe se o Tabelião o cadastrou e apontou a variável.
function templateCert() {
  const t = String(process.env.WHATS_TEMPLATE_CERT || '').trim();
  return t || null;
}

function variaveisDoReciboCert(p, numero) {
  const q = p || {};
  const c = q.cert || {};
  return [
    campo(dataHoraDoProtocolo()),
    campo(c.especie, 'Certidão ou traslado'),
    campo((c.solicitante && c.solicitante.nome) || (q.apresentante && q.apresentante.nome)),
    campo((c.parte && c.parte.nome) || (q.parte_envolvida && q.parte_envolvida.nome)),
    campo(numero)
  ];
}

// Corpo do template, para o cadastro pela API da Meta (POST /{WABA_ID}/message_templates)
// ou para copiar no WhatsApp Manager. Mantido aqui para que o texto e a ordem das
// variáveis nunca se separem do código que as monta.
function definicaoTemplateCert(nome) {
  return {
    name: String(nome || 'recibo_certidao_1').trim(),
    language: 'pt_BR',
    category: 'UTILITY',
    components: [{
      type: 'BODY',
      text: '*CARTÓRIO DE NOTAS DO 2º OFÍCIO — ITABAIANA/SE*\n\n' +
            'Recibo de protocolo — {{1}}\n' +
            'Pedido: {{2}}\n' +
            'Solicitante: {{3}}\n' +
            'Ato procurado em nome de: {{4}}\n\n' +
            '*Nº do protocolo: {{5}}*\n\n' +
            'Guarde este número: use-o para acompanhar o seu pedido em cn2oita.com.br ou informe-o à atendente do cartório.',
      example: { body_text: [[
        '23/09/2026, 14:05:10', 'Certidão de inteiro teor', 'MARIA JOSÉ DA SILVA', 'JOÃO PEREIRA DOS SANTOS', '1460'
      ]] }
    }]
  };
}

module.exports = { variaveisDoReciboCert, templateCert, definicaoTemplateCert, TEMPLATE_CERT_VARIAVEIS };
