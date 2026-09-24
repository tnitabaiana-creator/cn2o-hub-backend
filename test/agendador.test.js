'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { devidos, primeiroDiaUtil } = require('../agendador');
const { periodo, periodoAnterior } = require('../relatorios');
const { local } = require('../horas-uteis');

const L = s => local(new Date(s + ':00-03:00'));
const tarefas = s => devidos(L(s)).map(t => t.tarefa);

test('primeiro dia útil do mês pula fim de semana e feriado', () => {
  assert.equal(primeiroDiaUtil(2026, 9), '2026-09-01');    // terça
  assert.equal(primeiroDiaUtil(2026, 2), '2026-02-02');    // 01/02 domingo
  assert.equal(primeiroDiaUtil(2026, 11), '2026-11-03');   // 01 dom, 02 Finados
  assert.equal(primeiroDiaUtil(2027, 1), '2027-01-04');    // 01 feriado (sex), 02-03 fim de semana
});

test('segunda-feira: reconciliação às 7h, semanal às 8h', () => {
  assert.deepEqual(tarefas('2026-09-28T06:59'), []);
  assert.deepEqual(tarefas('2026-09-28T07:00'), ['reconciliacao']);
  assert.deepEqual(tarefas('2026-09-28T07:59'), ['reconciliacao']);
  assert.deepEqual(tarefas('2026-09-28T08:00'), ['reconciliacao', 'semanal']);
  assert.deepEqual(tarefas('2026-09-29T08:00'), ['reconciliacao']);            // terça comum
});

test('mensal no 1º dia útil às 8h — inclusive quando cai numa segunda', () => {
  assert.deepEqual(tarefas('2026-10-01T08:30'), ['reconciliacao', 'mensal']);  // quinta
  assert.deepEqual(tarefas('2026-11-02T09:00'), ['reconciliacao', 'semanal']); // Finados: segunda, mas não é dia útil
  assert.deepEqual(tarefas('2026-11-03T09:00'), ['reconciliacao', 'mensal']);
  assert.deepEqual(tarefas('2026-02-02T08:00'), ['reconciliacao', 'semanal', 'mensal']);
});

test('período do relatório semanal: a semana (seg–dom) anterior', () => {
  const p = periodo('semanal', '2026-09-28');
  assert.equal(p.inicioISO, '2026-09-21');
  assert.equal(p.fimISO, '2026-09-27');
  assert.equal(p.inicio.toISOString(), '2026-09-21T03:00:00.000Z');
  assert.equal(p.fim.toISOString(), '2026-09-28T03:00:00.000Z');         // fim exclusivo
  assert.equal(periodo('semanal', '2026-10-01').inicioISO, '2026-09-21'); // qualquer dia da semana seguinte
  assert.equal(periodo('semanal', '2026-09-27').inicioISO, '2026-09-14'); // domingo ainda é a semana corrente
  const a = periodoAnterior('semanal', p);
  assert.deepEqual([a.inicioISO, a.fimISO], ['2026-09-14', '2026-09-20']);
});

test('período do relatório mensal: o mês anterior, com virada de ano', () => {
  const p = periodo('mensal', '2026-10-01');
  assert.deepEqual([p.inicioISO, p.fimISO], ['2026-09-01', '2026-09-30']);
  const j = periodo('mensal', '2027-01-04');
  assert.deepEqual([j.inicioISO, j.fimISO], ['2026-12-01', '2026-12-31']);
  const m = periodo('mensal', '2026-03-02');
  assert.deepEqual([m.inicioISO, m.fimISO], ['2026-02-01', '2026-02-28']);
  const a = periodoAnterior('mensal', p);
  assert.deepEqual([a.inicioISO, a.fimISO], ['2026-08-01', '2026-08-31']);
  assert.throws(() => periodo('anual', '2026-10-01'), /inválido/);
});
