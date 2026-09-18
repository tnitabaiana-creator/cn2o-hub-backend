// whats.js — disparo do recibo de protocolo pela Meta Cloud API
// -----------------------------------------------------------------------------
// Template do recibo: o nome vem de WHATS_TEMPLATE_RECIBO. Quem monta as
// variáveis é o ./recibo.js, que ajusta a QUANTIDADE e a ORDEM ao template
// configurado — mandar número de parâmetros diferente do aprovado faz a Meta
// recusar (132000); mandar na ordem errada faz o cliente receber dados trocados.
//
//   recibo_protocolo_2 (aprovado, texto antigo) ....... 1 variável: o protocolo
//   recibo_protocolo_3 (pt_BR, Utilidade) ............. 5 variáveis:
//     {{1}} data e hora do protocolo
//     {{2}} tipo de ato por extenso
//     {{3}} parte / comprador(a)
//     {{4}} apresentante
//     {{5}} número do protocolo
//
// Texto do recibo_protocolo_3:
//   (cabeçalho) CARTÓRIO DE NOTAS DO 2º OFÍCIO — ITABAIANA/SE
//   Olá! Seu ato foi protocolado no Cartório de Notas do 2º Ofício de
//   Itabaiana/SE. Confira os dados do seu recibo:
//   Data e hora: {{1}}
//   Ato: {{2}}
//   Comprador(a): {{3}}
//   Apresentante: {{4}}
//   Nº do protocolo: {{5}}
//   Guarde este número para consultar o andamento do seu ato em cn2oita.com.br
//   ou informe-o à atendente do cartório.
//   Agradecemos sua confiança.
//
// Cabeçalho fixo (sem variável): o payload só envia o componente "body".
//
// Variáveis de ambiente:
//   WHATS_URL    https://graph.facebook.com/v22.0/1249774464882525/messages
//   WHATS_TOKEN  token permanente do System User (começa com EAA)
//   WHATS_TEMPLATE_RECIBO  recibo_protocolo_3
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
// Histórico em memória dos últimos envios para diagnóstico (via GET /whats/status)
const ultimosEnvios = [];
const MAX_LOGS = 30;

function registrarHistorico(item) {
  ultimosEnvios.unshift({ hora: new Date().toISOString(), ...item });
  if (ultimosEnvios.length > MAX_LOGS) ultimosEnvios.pop();
}

function statusWhatsApp() {
  const url = (process.env.WHATS_URL || '').trim();
  const token = (process.env.WHATS_TOKEN || '').trim();
  const template = (process.env.WHATS_TEMPLATE_RECIBO || 'recibo_protocolo_2').trim();
  return {
    configurado: Boolean(url && token),
    template,
    url_configurada: Boolean(url),
    token_configurado: Boolean(token),
    ultimos_envios: ultimosEnvios
  };
}

/**
 * Normaliza para E.164 do Brasil (55 + DDD + número).
 * Trata:
 *   - Números com 0 à esquerda do DDD (ex: 079 99988-7766 -> 5579999887766)
 *   - Números com código de operadora (ex: 015 79 99988-7766 -> 5579999887766)
 *   - Números com prefixo 00 (ex: 0055 79... -> 5579...)
 *   - Números digitados sem DDD no balcão (8 ou 9 dígitos -> assume DDD 79 de Itabaiana/SE)
 *   - Preserva o caso de DDD 55 (Santa Maria/RS)
 */
function normalizaTelefone(t) {
  if (!t) return null;
  let d = String(t).replace(/\D/g, '');
  if (!d) return null;

  // Remove prefixo internacional '00' (ex: 0055...)
  if (d.startsWith('00')) d = d.slice(2);

  // Se tem código de país 55 seguido de 0 e DDD (ex: 55079...)
  if (d.startsWith('550') && (d.length === 13 || d.length === 14)) {
    d = '55' + d.slice(3);
  }

  // Remove zeros ou código de operadora antes do DDD (ex: 079... ou 01579...)
  if (d.startsWith('0')) {
    if (d.length === 12 || d.length === 11) {
      d = d.slice(1);
    } else if (d.length === 14 || d.length === 13) {
      d = d.slice(3);
    }
  }

  // Sem DDD (8 ou 9 dígitos): assume o DDD 79 de Itabaiana/SE
  if (d.length === 8 || d.length === 9) {
    d = `79${d}`;
  }

  // 10 ou 11 dígitos (DDD + número): prefixa 55
  if (d.length === 10 || d.length === 11) {
    return `55${d}`;
  }

  // Já completo com 55 e 12 ou 13 dígitos
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    return d;
  }

  return null;
}

/**
 * Faz o disparo HTTP para a Meta Cloud API.
 */
async function postMeta(to, templateName, variaveis, url, token) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'pt_BR' },
      components: [{
        type: 'body',
        parameters: variaveis.map(v => ({ type: 'text', text: String(v) }))
      }]
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const dados = await res.json().catch(() => ({}));
  return { res, dados };
}

async function enviarTemplate(telefone, variaveis, nomeTemplate) {
  const to = normalizaTelefone(telefone);
  if (!to) {
    const errObj = { ok: false, motivo: `telefone inválido ("${telefone || ''}")` };
    registrarHistorico({ telOriginal: telefone, to: null, ...errObj });
    return errObj;
  }

  const url = (process.env.WHATS_URL || '').trim();
  const token = (process.env.WHATS_TOKEN || '').trim().replace(/^['"]|['"]$/g, '');
  const templateName = String(nomeTemplate || process.env.WHATS_TEMPLATE_RECIBO || 'recibo_protocolo_2').trim();

  if (!url || !token) {
    const errObj = { ok: false, to, motivo: 'WHATS_URL ou WHATS_TOKEN não configurados' };
    console.error(`[WhatsApp] Falha: WHATS_URL ou WHATS_TOKEN não configurados no ambiente.`);
    registrarHistorico({ telOriginal: telefone, to, template: templateName, ...errObj });
    return errObj;
  }

  try {
    let { res, dados } = await postMeta(to, templateName, variaveis, url, token);

    // Tratamento de inconsistência do 9º dígito no Brasil:
    // Se a Meta retornar erro 131026 (Message undeliverable), tenta com o formato alternativo (12 vs 13 dígitos)
    if (!res.ok && dados?.error?.code === 131026 && to.startsWith('55')) {
      let altTo = null;
      if (to.length === 13 && to[4] === '9') {
        // Remove o 9 após o DDD (ex: 5579998765432 -> 557998765432)
        altTo = to.slice(0, 4) + to.slice(5);
      } else if (to.length === 12) {
        // Insere o 9 após o DDD (ex: 557998765432 -> 5579998765432)
        altTo = to.slice(0, 4) + '9' + to.slice(4);
      }

      if (altTo) {
        console.warn(`[WhatsApp] Meta retornou 131026 para ${to}. Tentando formato alternativo ${altTo}…`);
        const tentativaAlt = await postMeta(altTo, templateName, variaveis, url, token);
        if (tentativaAlt.res.ok) {
          res = tentativaAlt.res;
          dados = tentativaAlt.dados;
          console.log(`[WhatsApp] Sucesso no formato alternativo ${altTo}!`);
        }
      }
    }

    if (!res.ok) {
      const e = dados?.error;
      const motivo = e
        ? `${e.message}${e.code ? ` (código ${e.code})` : ''}`
        : `HTTP ${res.status}`;
      console.error(`[WhatsApp] Erro ao enviar para ${to} (template=${templateName}): status ${res.status} — ${motivo}`, dados);
      const errObj = {
        ok: false,
        to,
        status: res.status,
        codigo_meta: e?.code,
        motivo,
        detalhe: dados
      };
      registrarHistorico({ telOriginal: telefone, to, template: templateName, ...errObj });
      return errObj;
    }

    const idMsg = dados?.messages?.[0]?.id || '(sem id)';
    console.log(`[WhatsApp] Recibo enviado com sucesso para ${to} (template=${templateName}): id ${idMsg}`);
    const okObj = { ok: true, to, idMsg };
    registrarHistorico({ telOriginal: telefone, to, template: templateName, ...okObj });
    return okObj;
  } catch (err) {
    console.error(`[WhatsApp] Exceção de rede ao enviar para ${to}:`, err.message);
    const errObj = { ok: false, to, motivo: err.message };
    registrarHistorico({ telOriginal: telefone, to, template: templateName, ...errObj });
    return errObj;
  }
}

/**
 * Dispara o recibo para o apresentante e, se houver telefone, para a parte.
 */
async function dispararRecibos(p, numero) {
  const template = (process.env.WHATS_TEMPLATE_RECIBO || 'recibo_protocolo_2').trim();
  const vars = variaveisDoRecibo(p, numero, template);

  const resultados = [];
  const tels = new Set();
  const tApresentante = normalizaTelefone(p?.apresentante?.telefone);
  const tParte = normalizaTelefone(p?.parte_envolvida?.telefone);

  if (tApresentante) tels.add(tApresentante);
  if (tParte) tels.add(tParte);

  if (tels.size === 0) {
    const motivo = `nenhum telefone válido no protocolo (apresentante: "${p?.apresentante?.telefone || ''}", parte: "${p?.parte_envolvida?.telefone || ''}")`;
    console.warn(`[WhatsApp] Prot ${numero}: ${motivo}`);
    registrarHistorico({ protocolo: numero, ok: false, motivo });
    return [{ ok: false, motivo }];
  }

  console.log(`[WhatsApp] Prot ${numero}: disparando recibo (template="${template}", vars=[${vars.map(v => JSON.stringify(v)).join(', ')}]) para destinatários: ${[...tels].join(', ')}`);

  for (const tel of tels) {
    const r = await enviarTemplate(tel, vars, template);
    resultados.push(r);
  }

  return resultados;
}

module.exports = {
  dispararRecibos,
  enviarTemplate,
  normalizaTelefone,
  statusWhatsApp,
  ATO_NOME
};

/* -----------------------------------------------------------------------------
 * HISTÓRICO — por que este arquivo mudou
 *
 * A primeira versão mandava uma variável só (o número) porque a Meta havia
 * recusado dois templates. O texto aprovado dizia "autuada no processo {{1}}",
 * errado no vocabulário da casa: cartório de notas PROTOCOLA título, não autua
 * processo — autuar processo é linguagem de juízo. O recibo_protocolo_3 corrige
 * o termo e reproduz o recibo impresso do balcão: data e hora, ato,
 * comprador(a), apresentante e número do protocolo.
 *
 * A ORDEM das variáveis é a do texto aprovado na Meta, e quem a define é o
 * recibo.js. Trocar só o nome na Railway (WHATS_TEMPLATE_RECIBO) funciona desde
 * que o recibo.js já saiba montar as variáveis do template novo.
 * ---------------------------------------------------------------------------*/
