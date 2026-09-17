// atos.js — nomes por extenso dos atos do e-Protocolo.
// -----------------------------------------------------------------------------
// Fonte única: o T-Consulta (hub.js) e o recibo do WhatsApp (whats.js) leem daqui,
// para que o cliente veja no recibo exatamente o mesmo nome de ato que a
// escrevente vê no extrato. Ao criar um ato novo no formulário, acrescente-o aqui.
const NOMES_ATO = {
  'CV-Urbano': 'Compra e venda — imóvel urbano',
  'CV-Rural': 'Compra e venda — imóvel rural',
  'DOA': 'Doação',
  'PER': 'Permuta',
  'INV': 'Inventário e partilha',
  'CDH': 'Cessão de direitos hereditários',
  'CDP': 'Cessão de direitos possessórios',
  'TEST': 'Testamento',
  'DIV': 'Divórcio',
  'UE': 'União estável',
  'DUE': 'Declaração de união estável',
  'PACTO': 'Pacto antenupcial',
  'RERRAT': 'Rerratificação',
  'ATA-U': 'Ata notarial para usucapião',
  'ATA-W/A': 'Ata notarial de mensagens e áudios'
};

module.exports = { NOMES_ATO };
