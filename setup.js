// setup.js — executar UMA vez (npm run setup) após preencher TRELLO_KEY/TOKEN.
// Cria os campos personalizados em todos os quadros, as labels e os webhooks.
// Pré-requisito: Power-Up "Campos Personalizados" ativado em cada quadro
// (Menu do quadro → Power-Ups → Custom Fields → Adicionar).
const { t } = require('./trello');

const CAMPOS = [
  { name: 'Protocolo', type: 'number' },
  { name: 'Extra', type: 'number' },
  { name: 'Tipo de Ato', type: 'list', options: ['CV-Urbano','CV-Rural','CDP','CDH','DOA','TEST','INV'] },
  { name: 'Apresentante', type: 'text' },
  { name: 'Tel Apresentante', type: 'text' },
  { name: 'Parte', type: 'text' },
  { name: 'Tel Parte', type: 'text' },
  { name: 'Data de Entrada', type: 'date' },
  { name: 'Escrevente', type: 'list', options: ['Josilene','Camily','Romênia','Lara','Jonas','Milvo','César Bravo'] },
  { name: 'Auditoria', type: 'list', options: ['Aprovado','Ajuste','Reprovado'] },
  { name: 'Vendedor', type: 'text' }
];

const LABELS_BANDEIRA = [
  ['Loteador/Incorporador','green'],
  ['Construtor','yellow'],
  ['Santa Mônica','pink'],
  ['Advogado','purple'],
  ['Corretor','black'],
  ['Urgente','red']
];

async function garantirCampos(boardId) {
  const atuais = await t('GET', `/boards/${boardId}/customFields`);
  const nomes = new Set(atuais.map(c => c.name));
  for (const c of CAMPOS) {
    if (nomes.has(c.name)) { console.log(`  ✓ campo já existe: ${c.name}`); continue; }
    const body = {
      idModel: boardId, modelType: 'board', name: c.name, type: c.type,
      pos: 'bottom', display_cardFront: ['Protocolo','Extra','Tipo de Ato'].includes(c.name)
    };
    if (c.type === 'list') body.options = c.options.map(o => ({ value: { text: o } }));
    await t('POST', '/customFields', body);
    console.log(`  + campo criado: ${c.name}`);
  }
}

async function garantirLabel(boardId, name, color) {
  const ls = await t('GET', `/boards/${boardId}/labels?limit=100`);
  if (ls.some(l => l.name === name)) { console.log(`  ✓ label já existe: ${name}`); return; }
  await t('POST', `/boards/${boardId}/labels`, { name, color });
  console.log(`  + label criada: ${name}`);
}

async function registrarWebhook(boardId) {
  const url = `${process.env.BASE_URL}/webhook/trello`;
  const atuais = await t('GET', `/tokens/${process.env.TRELLO_TOKEN}/webhooks`);
  if (atuais.some(w => w.idModel === boardId && w.callbackURL === url)) {
    console.log(`  ✓ webhook já existe: ${boardId}`); return;
  }
  await t('POST', '/webhooks', { idModel: boardId, callbackURL: url, description: `hub-protocolo ${boardId}` });
  console.log(`  + webhook registrado: ${boardId}`);
}

(async () => {
  const escreventes = (process.env.BOARDS_ESCREVENTES || '').split(',').filter(Boolean);
  const todos = [process.env.BOARD_00, process.env.BOARD_01, ...escreventes];

  for (const b of todos) {
    console.log(`\nQuadro ${b}:`);
    await garantirCampos(b);
  }
  for (const b of todos) {
    console.log(`\nLabels do quadro ${b}:`);
    for (const [nome, cor] of LABELS_BANDEIRA) await garantirLabel(b, nome, cor);
  }
  for (const b of todos) await registrarWebhook(b);

  // imprime o id da lista Protocolo/Entrada para o .env
  const listas = await t('GET', `/boards/${process.env.BOARD_00}/lists`);
  const entrada = listas.find(l => /protocolo\/entrada/i.test(l.name));
  console.log(`\nLISTA_ENTRADA=${entrada ? entrada.id : 'NÃO ENCONTRADA — confira o nome da lista'}`);
  console.log('\nSetup concluído.');
})().catch(e => { console.error(e); process.exit(1); });
