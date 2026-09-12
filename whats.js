// whats.js — disparo do recibo de protocolo pela Meta Cloud API
// -----------------------------------------------------------------------------
// Template em uso: recibo_protocolo_2 (pt_BR, Utilidade), com UMA variável:
//   {{1}} número do protocolo
//
// Texto aprovado:
//   Olá! Aqui é do Cartório de Notas do 2º Ofício de Itabaiana.
//   Sua documentação foi recebida e autuada no processo {{1}}, que já está em
//   andamento na serventia.
//   Guarde esta referência para futuras consultas. Qualquer dúvida, estamos à
//   disposição.
//   Atenciosamente,
//   Cartório de Notas do 2º Ofício de Itabaiana/SE
//
// Variáveis de ambiente:
//   WHATS_URL    https://graph.facebook.com/v22.0/1249774464882525/messages
//   WHATS_TOKEN  token permanente do System User (começa com EAA)
//   WHATS_TEMPLATE_RECIBO  recibo_protocolo_2
// -----------------------------------------------------------------------------

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
 * O template em uso tem apenas a variável do número do protocolo. Os dados de
 * ato, papel e nomes ficam disponíveis em `p` para quando houver um template
 * mais completo aprovado — ver observação no fim do arquivo.
 */
async function dispararRecibos(p, numero) {
  const vars = [String(numero)];

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
 * PARA DEPOIS — template completo
 *
 * A versão original deste arquivo previa 5 variáveis (ato, papel, nome da
 * parte, apresentante, protocolo). Esse template ainda não existe aprovado; a
 * Meta recusou duas tentativas de template com número, e só passou a versão
 * enxuta com o texto "autuada no processo {{1}}".
 *
 * Se um template de 5 variáveis vier a ser aprovado, bastam duas mudanças:
 *   1. WHATS_TEMPLATE_RECIBO aponta para o novo nome
 *   2. em dispararRecibos, trocar `vars` por:
 *        [ATO_NOME[p.ato] || p.ato, p.parte_envolvida.papel,
 *         p.parte_envolvida.nome, p.apresentante.nome, String(numero)]
 * ---------------------------------------------------------------------------*/
