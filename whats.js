// whats.js — disparo do recibo pela plataforma intermediária (Meta Cloud API)
// Template esperado: recibo_protocolo, com 5 variáveis de corpo:
// {{1}} ato por extenso · {{2}} papel da parte · {{3}} nome da parte
// {{4}} apresentante · {{5}} número do protocolo

const ATO_NOME = {
  'CV-Urbano': 'Escritura de Compra e Venda (imóvel urbano)',
  'CV-Rural': 'Escritura de Compra e Venda (imóvel rural)',
  'CDP': 'Escritura de Cessão de Direitos Possessórios',
  'CDH': 'Escritura de Cessão de Direitos Hereditários',
  'DOA': 'Escritura de Doação',
  'TEST': 'Testamento Público',
  'INV': 'Escritura de Inventário e Partilha',
  'PERM': 'Escritura de Permuta',
  'DIV': 'Escritura de Divórcio',
  'UE': 'Escritura de União Estável',
  'UE-DIS': 'Escritura de Dissolução de União Estável',
  'RERRAT': 'Escritura de Re-ratificação',
  'ATA-USO': 'Ata Notarial para Usucapião',
  'ATA-W': 'Ata Notarial de Mensagens Eletrônicas'
};

function normalizaTelefone(t) {
  const d = (t || '').replace(/\D/g, '');
  if (!d) return null;
  return d.startsWith('55') ? d : `55${d}`;
}

async function enviarTemplate(telefone, variaveis) {
  const to = normalizaTelefone(telefone);
  if (!to) return { ok: false, motivo: 'sem telefone' };
  const res = await fetch(process.env.WHATS_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WHATS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: process.env.WHATS_TEMPLATE_RECIBO,
        language: { code: 'pt_BR' },
        components: [{
          type: 'body',
          parameters: variaveis.map(v => ({ type: 'text', text: String(v) }))
        }]
      }
    })
  });
  const corpo = await res.text();
  return { ok: res.ok, status: res.status, corpo };
}

// dispara para apresentante e, se houver telefone, para a parte
async function dispararRecibos(p, numero) {
  const vars = [
    ATO_NOME[p.ato] || p.ato,
    p.parte_envolvida.papel,
    p.parte_envolvida.nome,
    p.apresentante.nome,
    String(numero)
  ];
  const resultados = [];
  resultados.push(await enviarTemplate(p.apresentante.telefone, vars));
  if (p.parte_envolvida.telefone) {
    resultados.push(await enviarTemplate(p.parte_envolvida.telefone, vars));
  }
  return resultados;
}

module.exports = { dispararRecibos, ATO_NOME };
