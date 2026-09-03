// trello.js — helpers da API REST do Trello
const BASE = 'https://api.trello.com/1';
const auth = () => `key=${process.env.TRELLO_KEY}&token=${process.env.TRELLO_TOKEN}`;

async function t(method, path, body) {
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}${auth()}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`Trello ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---- cache de definições por quadro (campos personalizados e labels) ----
const cacheCampos = new Map(); // boardId -> { nomeDoCampo: {id, type, options} }
const cacheLabels = new Map(); // boardId -> { nomeDaLabel: id }

async function camposDoQuadro(boardId) {
  if (!cacheCampos.has(boardId)) {
    const defs = await t('GET', `/boards/${boardId}/customFields`);
    const mapa = {};
    for (const d of defs) mapa[d.name] = { id: d.id, type: d.type, options: d.options || [] };
    cacheCampos.set(boardId, mapa);
  }
  return cacheCampos.get(boardId);
}

async function labelsDoQuadro(boardId) {
  if (!cacheLabels.has(boardId)) {
    const ls = await t('GET', `/boards/${boardId}/labels?limit=100`);
    const mapa = {};
    for (const l of ls) if (l.name) mapa[l.name] = l.id;
    cacheLabels.set(boardId, mapa);
  }
  return cacheLabels.get(boardId);
}

// ---- operações usadas pelo hub ----
async function criarCartao({ idList, name, desc, due, idLabels }) {
  return t('POST', '/cards', { idList, name, desc, due, idLabels, pos: 'bottom' });
}

// aplica valores de campos personalizados num cartão, mapeando POR NOME de campo
async function aplicarCampos(cardId, boardId, valores) {
  const defs = await camposDoQuadro(boardId);
  for (const [nome, valor] of Object.entries(valores)) {
    const def = defs[nome];
    if (!def || valor === null || valor === undefined || valor === '') continue;
    let body;
    if (def.type === 'list') {
      const opt = def.options.find(o => o.value?.text === String(valor));
      if (!opt) continue;
      body = { idValue: opt.id };
    } else if (def.type === 'number') {
      body = { value: { number: String(valor) } };
    } else if (def.type === 'date') {
      body = { value: { date: new Date(valor).toISOString() } };
    } else {
      body = { value: { text: String(valor) } };
    }
    await t('PUT', `/cards/${cardId}/customField/${def.id}/item`, body);
  }
}

async function criarChecklistDossie(cardId, recebidos, pendentes) {
  const cl = await t('POST', '/checklists', { idCard: cardId, name: 'DOSSIÊ' });
  for (const item of recebidos) {
    await t('POST', `/checklists/${cl.id}/checkItems`, { name: item, checked: true });
  }
  for (const item of pendentes) {
    await t('POST', `/checklists/${cl.id}/checkItems`, { name: item, checked: false });
  }
  return cl.id;
}

async function aplicarLabelsPorNome(cardId, boardId, nomes) {
  const mapa = await labelsDoQuadro(boardId);
  for (const nome of nomes) {
    const id = mapa[nome];
    if (!id) continue;
    try { await t('POST', `/cards/${cardId}/idLabels`, { value: id }); }
    catch (e) { if (!/already/i.test(e.message)) throw e; }
  }
}

// capa colorida = bandeiramento visível na frente do cartão (a label sozinha é discreta)
// cores aceitas pelo Trello: pink, green, yellow, purple, black, red, orange, blue, sky, lime
async function aplicarCapa(cardId, cor) {
  if (!cor) return null;
  const brightness = ['yellow', 'lime', 'sky'].includes(cor) ? 'light' : 'dark';
  return t('PUT', `/cards/${cardId}`, { cover: { color: cor, brightness, size: 'full' } });
}

async function cartoesDaLista(listId) {
  return t('GET', `/lists/${listId}/cards?fields=name,desc`);
}

async function obterCartao(cardId) {
  return t('GET', `/cards/${cardId}?fields=name,idBoard,idList,desc`);
}

module.exports = {
  t, camposDoQuadro, labelsDoQuadro,
  criarCartao, aplicarCampos, criarChecklistDossie, aplicarLabelsPorNome, aplicarCapa,
  cartoesDaLista, obterCartao
};
