'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const R = require('../rastreio');

test('cartão exclusivamente setorial não apaga nem grava projeções legadas', async () => {
  const original = db.pool.connect, sql = [];
  db.pool.connect = async () => ({
    query: async text => {
      sql.push(text);
      if (/SELECT action_id/.test(text)) {
        assert.match(text, /origem <> 'carga_setorial'/);
        return { rows: [] };
      }
      assert.doesNotMatch(text, /DELETE|INSERT|UPDATE/);
      return { rows: [] };
    }, release() {}
  });
  try {
    const result = await R.processarCartao('card-somente-setorial');
    assert.equal(result.ignorado_setorial, true);
    assert.ok(sql.includes('COMMIT'));
  } finally { db.pool.connect = original; }
});

test('reprocessamento normal e completo excluem a fotografia setorial', async () => {
  const original = db.pool.query, sql = [];
  db.pool.query = async text => { sql.push(text); return { rows: [] }; };
  try {
    assert.equal(await R.reprocessar(), 0); assert.equal(await R.reprocessar({ todos: true }), 0);
    assert.ok(sql.every(s => /origem <> 'carga_setorial'/.test(s)));
    assert.match(sql[0], /processado_em IS NULL/);
    assert.doesNotMatch(sql[1], /processado_em IS NULL/);
  } finally { db.pool.query = original; }
});

test('somente webhook com a mesma identidade pode promover uma ação setorial; carga periódica não promove', async () => {
  const original = db.pool.query;
  db.pool.query = async (sql, values) => {
    assert.match(sql, /eventos_trello.origem = 'carga_setorial' AND EXCLUDED.origem = 'webhook'/);
    for (const field of ['tipo','card_id','ocorrido_em']) assert.ok(sql.includes(`eventos_trello.${field} = EXCLUDED.${field}`));
    assert.match(sql, /board_id IS NOT DISTINCT FROM EXCLUDED.board_id/);
    assert.match(sql, /processado_em = NULL/);
    return { rowCount: values[5] === 'webhook' ? 1 : 0 };
  };
  const a = { id: 'action-id', type: 'createCard', date: '2026-10-13T12:00:00Z', data: { card: { id: 'card-id' }, board: { id: 'board-id' } } };
  try { assert.equal(await R.registrarEvento(a, 'webhook'), 1); assert.equal(await R.registrarEvento(a, 'carga'), 0); }
  finally { db.pool.query = original; }
});
