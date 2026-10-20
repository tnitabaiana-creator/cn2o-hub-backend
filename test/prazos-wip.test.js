'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../prazos-wip');
const agora = new Date('2026-10-20T15:00:00Z');
const linha = (card_id, extra = {}) => ({
  card_id, estado: 'ativo', vencimento: '2026-10-20T14:59:59Z',
  responsavel_login: 'test.writer', confirmado_em: '2026-10-20T14:59:00Z', erro: null, ...extra
});

test('assinatura usa prazo canônico, nunca due da agenda nem dueComplete', () => {
  const r = W.resumir([
    { id: 'a', due: '2099-01-01', dueComplete: true },
    { id: 'b', due: '2000-01-01', dueComplete: false }
  ], [
    linha('a', { estado: 'assinatura' }),
    linha('b', { estado: 'assinatura', vencimento: '2026-10-21T15:00:00Z' })
  ], 'test.writer', agora);
  assert.equal(r.total, 2);
  assert.equal(r.atrasados, 1);
  assert.equal(r.sem_prazo_confirmado, 0);
});

test('falhas, prazo ausente, fonte antiga ou responsável divergente não viram ausência de atraso', () => {
  const cards = ['ausente', 'antigo', 'erro', 'outro', 'concluido', 'invalido', 'futuro'].map(id => ({ id }));
  const rows = [
    linha('antigo', { confirmado_em: '2026-10-20T14:00:00Z' }),
    linha('erro', { erro: 'trello_timeout' }),
    linha('outro', { responsavel_login: 'test.other' }),
    linha('concluido', { estado: 'concluido' }),
    linha('invalido', { vencimento: null }),
    linha('futuro', { confirmado_em: '2026-10-20T15:01:00Z' })
  ];
  const r = W.resumir(cards, rows, 'test.writer', agora);
  assert.equal(r.total, 7);
  assert.equal(r.sem_prazo_confirmado, 7);
  assert.equal(r.atrasados, 0);
});

test('limite exato permanece no prazo e cartões não se duplicam', () => {
  const r = W.resumir([{ id: 'a' }, { id: 'a' }], [linha('a', { vencimento: agora.toISOString() })], 'test.writer', agora);
  assert.equal(r.total, 1);
  assert.equal(r.atrasados, 0);
});

test('consulta lê cartões e prazos em lote, sem datas de assinatura nem escrita', async () => {
  const chamadas = [], consultas = [];
  const trello = { t: async (metodo, url) => {
    chamadas.push([metodo, url]);
    if (url.includes('/lists?')) return [{ id: 'lista-ativa', name: 'assinatura' }, { id: 'lista-final', name: 'finalizado' }];
    return [{ id: 'a', idList: 'lista-ativa' }, { id: 'b', idList: 'lista-final' }];
  } };
  const pool = { query: async (sql, params) => { consultas.push([sql, params]); return { rows: [linha('a')] }; } };
  const r = await W.consultar({ pool, trello, escreventes: [{ login: 'test.writer', board_id: 'board' }], rastreio: { categoriaDaLista: s => s }, agora });
  assert.equal(r['test.writer'].total, 1);
  assert.equal(r['test.writer'].atrasados, 1);
  assert.equal(consultas.length, 1);
  assert.deepEqual(consultas[0][1], [['a']]);
  assert.match(consultas[0][0], /^\s*SELECT /);
  assert.equal(chamadas.every(([m]) => m === 'GET'), true);
  assert.equal(chamadas.some(([, u]) => /due/.test(u)), false);
});

test('falha SQL preserva total com prazo pendente e falha Trello não fabrica carteira vazia', async () => {
  const r = await W.consultar({
    pool: { query: async () => { throw Error('indisponivel'); } },
    trello: { t: async (_, url) => {
      if (url.includes('board-b')) throw Error('indisponivel');
      if (url.includes('/lists?')) return [{ id: 'lista', name: 'elaboracao' }];
      return [{ id: 'a', idList: 'lista' }];
    } },
    escreventes: [{ login: 'test.writer', board_id: 'board-a' }, { login: 'test.other', board_id: 'board-b' }],
    rastreio: { categoriaDaLista: s => s }, agora
  });
  assert.equal(r['test.writer'].total, 1);
  assert.equal(r['test.writer'].sem_prazo_confirmado, 1);
  assert.equal(r['test.other'], null);
});

test('prévia HTML mostra prazo canônico e pendência sem enviar mensagem', () => {
  const reports = require('../reports'), email = require('../relatorio-email');
  const rel = reports.calcular({
    tipo: 'semanal',
    periodo: { inicio: new Date('2026-10-12T03:00:00Z'), fim: new Date('2026-10-19T03:00:00Z'),
      inicioISO: '2026-10-12', fimISO: '2026-10-18' },
    escreventes: [{ login: 'test.writer', nome: 'Pessoa fictícia' }],
    pesos: {}, conclusoes: [],
    wip: { 'test.writer': { total: 3, atrasados: 1, sem_prazo_confirmado: 2 } }
  });
  rel.pesos = {};
  const html = email.html(rel);
  assert.match(html, /3 cartão\(ões\) no quadro agora/);
  assert.match(html, /1 com prazo do ato vencido/);
  assert.match(html, /2 sem prazo confirmado nesta consulta/);
});
