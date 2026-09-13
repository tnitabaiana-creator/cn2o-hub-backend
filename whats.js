// whats.js — disparo do recibo de protocolo pela Meta Cloud API
// -----------------------------------------------------------------------------
// Template do recibo: o nome vem de WHATS_TEMPLATE_RECIBO. Quem monta as
// variáveis é o ./recibo.js, que ajusta a QUANTIDADE ao template configurado —
// mandar número de parâmetros diferente do aprovado faz a Meta recusar (132000).
//
//   recibo_protocolo_2 (aprovado, texto antigo) ....... 1 variável: o protocolo
//   recibo_protocolo_3 (pt_BR, Utilidade) ............. 5 variáveis:
//     {{1}} número do protocolo (o template imprime em negrito)
//     {{2}} tipo de ato por extenso
//     {{3}} apresentante
//     {{4}} parte / comprador(a)
//     {{5}} vendedor(a) / transmitente
//
// Texto do recibo_protocolo_3:
//   Olá! Aqui é do Cartório de Notas do 2º Ofício de Itabaiana/SE.
//   Recebemos e protocolamos a documentação apresentada.
//   Protocolo nº *{{1}}*
//   Tipo de ato: {{2}}
//   Apresentante: {{3}}
//   Parte/comprador(a): {{4}}
//   Vendedor(a)/transmitente: {{5}}
//   Guarde o número do protocolo: é por ele que o senhor(a) acompanha o
//   andamento do serviço na serventia. Qualquer dúvida, estamos à disposição.
//   (rodapé) Cartório de Notas do 2º Ofício de Itabaiana/SE
//
// Variáveis de ambiente:
//   WHATS_URL    https://graph.facebook.com/v22.0/1249774464882525/messages
//   WHATS_TOKEN  token permanente do System User (começa com EAA)
//   WHATS_TEMPLATE_RECIBO  recibo_protocolo_2
// -----------------------------------------------------------------------------

const { variaveisDoRecibo } = require('./recibo'); // as variáveis do recibo

const TEMPLATE = process.env.WHATS_TEMPLATE_RECIBO || 'recibo_protocolo_2';

const ATO_NOME = {
  'CV-Urbano': 'Escritura de Compra e Venda (imóvel urbano)',
  'CV-Rural': 'Escritura de Compra e Venda (imóvel rural)',
  'CDP': 'Escritura de Cessão de Direitos Possessórios',
  'CDH': 'Escritura de Cessão de Direitos Hereditários',
  'DOA': 'Escritura de Doação',
  'TEST': 'Testamento Público',
  'INV': 'Escritura de Inventário e Partilha',
  'PER': 'Escritura de Permuta',
  'DIV': 'Escritura de Divórcio',
  'UE': 'Escritura de União Estável',
  'DUE': 'Escritura de Dissolução de União Estável',
  'RERRAT': 'Escritura de Re-ratificação',
  'ATA-U': 'Ata Notarial para Usucapião',
  'ATA-W/A': 'Ata Notarial de Mensagens e Áudios'
};

/**
 * Normaliza para E.164 do Brasil.
 *
 * ATENÇÃO ao caso que a versão anterior errava: DDD 55 existe (Santa Maria/RS).
 * Checar só o prefixo "55" faria um número de lá ser tratado como se já tivesse
 * código de país. Por isso a verificação considera o comprimento:
 *   - 10 ou 11 dígitos  -> falta o código do país, prefixa 55
 *   - 12 ou 13 dígitos iniciando em 55 -> já completo
 *   - qualquer outra coisa -> null (melhor não enviar do que enviar errado)
 */
function normalizaTelefone(t) {
  const d = (t || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return d;
  return null;
}

async function enviarTemplate(telefone, variaveis) {
  const to = normalizaTelefone(telefone);
  if (!to) return { ok: false, motivo: `telefone inválido ("${telefone || ''}")` };

  if (!process.env.WHATS_URL || !process.env.WHATS_TOKEN) {
    return { ok: false, motivo: 'WHATS_URL ou WHATS_TOKEN não configurados' };
  }

  try {
    const res = await fetch(process.env.WHATS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WHATS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'template',
        template: {
          name: TEMPLATE,
          language: { code: 'pt_BR' },
          components: [{
            type: 'body',
            parameters: variaveis.map(v => ({ type: 'text', text: String(v) }))
          }]
        }
      })
    });

    const dados = await res.json().catch(() => ({}));

    if (!res.ok) {
      const e = dados?.error;
      return {
        ok: false,
        to,
        status: res.status,
        motivo: e
          ? `${e.message}${e.code ? ` (código ${e.code})` : ''}`
          : `HTTP ${res.status}`
      };
    }

    return { ok: true, to, idMsg: dados?.messages?.[0]?.id || '(sem id)' };
  } catch (err) {
    // Nunca lança: WhatsApp fora do ar não pode travar a geração do protocolo.
    return { ok: false, to, motivo: err.message };
  }
}

/**
 * Dispara o recibo para o apresentante e, se houver telefone, para a parte.
 *
 * O recibo leva o protocolo, o tipo de ato por extenso, o apresentante, a parte/
 * comprador(a) e o vendedor(a) — a mesma ordem do extrato do T-Consulta. Quem
 * monta as variáveis é ./recibo.js, que divide o mapa de atos com o T-Consulta
 * e ajusta a quantidade delas ao template que estiver configurado.
 */
async function dispararRecibos(p, numero) {
  const vars = variaveisDoRecibo(p, numero, TEMPLATE);

  const resultados = [];

  const tels = new Set();
  const tApresentante = normalizaTelefone(p?.apresentante?.telefone);
  const tParte = normalizaTelefone(p?.parte_envolvida?.telefone);

  if (tApresentante) tels.add(tApresentante);
  if (tParte) tels.add(tParte);   // Set evita mensagem dupla quando forem iguais

  if (tels.size === 0) {
    return [{ ok: false, motivo: 'nenhum telefone válido no protocolo' }];
  }

  for (const tel of tels) {
    resultados.push(await enviarTemplate(tel, vars));
  }

  return resultados;
}

module.exports = { dispararRecibos, enviarTemplate, normalizaTelefone, ATO_NOME };

/* -----------------------------------------------------------------------------
 * HISTÓRICO — por que este arquivo mudou
 *
 * A primeira versão mandava uma variável só (o número) porque a Meta havia
 * recusado dois templates. O texto aprovado dizia "autuada no processo {{1}}",
 * errado no vocabulário da casa: cartório de notas PROTOCOLA título, não autua
 * processo — autuar processo é linguagem de juízo. O recibo_protocolo_3 corrige
 * o termo, põe o número do protocolo em negrito e leva o padrão do extrato do
 * T-Consulta: apresentante, parte/comprador(a), vendedor(a) e tipo de ato.
 *
 * A troca é UMA LINHA na Railway (WHATS_TEMPLATE_RECIBO). Quem decide quantas
 * variáveis mandar é o recibo.js, pelo nome do template — por isso nada aqui
 * precisa mudar de novo quando um template novo for aprovado.
 * ---------------------------------------------------------------------------*/