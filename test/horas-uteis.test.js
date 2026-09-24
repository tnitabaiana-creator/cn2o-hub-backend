'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { criarCalendario, pascoa, local, meiaNoiteLocal, somaDias } = require('../horas-uteis');

const cal = criarCalendario();                 // 08:00-12:00, 13:00-17:00
const L = s => new Date(s + ':00-03:00');      // hora local de Sergipe → Date

test('Páscoa (Meeus) e feriados móveis', () => {
  const dia = ms => new Date(ms).toISOString().slice(0, 10);
  assert.equal(dia(pascoa(2025)), '2025-04-20');
  assert.equal(dia(pascoa(2026)), '2026-04-05');
  assert.equal(dia(pascoa(2027)), '2027-03-28');
  const f = cal.feriadosDoAno(2026);
  for (const d of ['2026-02-16', '2026-02-17', '2026-04-03', '2026-06-04']) assert.ok(f.has(d), d);
});

test('feriados fixos nacionais e de Sergipe', () => {
  for (const d of ['2026-01-01', '2026-04-21', '2026-05-01', '2026-07-08', '2026-09-07', '2026-10-12',
    '2026-11-02', '2026-11-15', '2026-11-20', '2026-12-25']) {
    assert.equal(cal.ehDiaUtil(d), false, d);
  }
  assert.equal(cal.ehDiaUtil('2026-09-24'), true);      // quinta comum
  assert.equal(cal.ehDiaUtil('2026-09-26'), false);     // sábado
});

test('fim de semana não conta: sexta 16h → segunda 9h = 2 h úteis', () => {
  assert.equal(cal.horasUteis(L('2026-09-25T16:00'), L('2026-09-28T09:00')), 2);
});

test('almoço não conta: 11h → 14h = 2 h úteis', () => {
  assert.equal(cal.horasUteis(L('2026-09-24T11:00'), L('2026-09-24T14:00')), 2);
});

test('feriado não conta: sex 04/09 10h → ter 08/09 10h (07/09 no meio) = 8 h úteis', () => {
  assert.equal(cal.horasUteis(L('2026-09-04T10:00'), L('2026-09-08T10:00')), 8);
});

test('fora do expediente e intervalos inválidos = 0', () => {
  assert.equal(cal.horasUteis(L('2026-09-26T10:00'), L('2026-09-27T18:00')), 0);   // sáb → dom
  assert.equal(cal.horasUteis(L('2026-09-24T18:00'), L('2026-09-24T22:00')), 0);   // noite
  assert.equal(cal.horasUteis(L('2026-09-24T10:00'), L('2026-09-24T09:00')), 0);   // invertido
  assert.equal(cal.horasUteis(null, L('2026-09-24T09:00')), 0);
});

test('semana cheia = 40 h úteis; dia inteiro = horasPorDia', () => {
  assert.equal(cal.horasUteis(L('2026-09-21T00:00'), L('2026-09-28T00:00')), 40);
  assert.equal(cal.horasPorDia, 8);
});

test('EXPEDIENTE e FERIADOS_EXTRA configuráveis', () => {
  const c = criarCalendario({ expediente: '07:00-13:00', feriadosExtra: '08-28,2026-12-24' });
  assert.equal(c.horasPorDia, 6);
  assert.equal(c.horasUteis(L('2026-09-24T06:00'), L('2026-09-24T18:00')), 6);
  assert.equal(c.ehDiaUtil('2026-08-28'), false);       // municipal, todo ano
  assert.ok(c.feriadosDoAno(2027).has('2027-08-28'));
  assert.equal(c.ehDiaUtil('2026-12-24'), false);       // avulso
  assert.equal(c.ehDiaUtil('2027-12-24'), true);
  assert.throws(() => criarCalendario({ expediente: '8h às 17h' }), /EXPEDIENTE/);
});

test('datas locais de Sergipe (UTC-3)', () => {
  const l = local(new Date('2026-09-28T02:30:00Z'));    // domingo 27/09, 23:30 local
  assert.equal(l.data, '2026-09-27');
  assert.equal(l.diaSemana, 0);
  assert.equal(l.minutos, 23 * 60 + 30);
  assert.equal(meiaNoiteLocal('2026-09-28').toISOString(), '2026-09-28T03:00:00.000Z');
  assert.equal(somaDias('2026-02-28', 1), '2026-03-01');
  assert.equal(somaDias('2026-01-01', -1), '2025-12-31');
});
