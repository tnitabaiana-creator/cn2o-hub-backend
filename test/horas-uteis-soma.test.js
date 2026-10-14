'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { criarCalendario, somarHorasUteis } = require('../horas-uteis');
const cal = criarCalendario();

const casos = [
  ['oito horas do expediente completo', '2026-10-13T08:00:00-03:00', 8, '2026-10-13T17:00:00-03:00'],
  ['intervalo do almoço', '2026-10-13T11:30:00-03:00', 2, '2026-10-13T14:30:00-03:00'],
  ['entrada durante almoço', '2026-10-13T12:30:00-03:00', 1, '2026-10-13T14:00:00-03:00'],
  ['entrada antes de abrir', '2026-10-13T06:00:00-03:00', 1, '2026-10-13T09:00:00-03:00'],
  ['entrada no encerramento', '2026-10-13T17:00:00-03:00', 1, '2026-10-14T09:00:00-03:00'],
  ['prazo exato no início do almoço', '2026-10-13T11:00:00-03:00', 1, '2026-10-13T12:00:00-03:00'],
  ['fim de semana', '2026-10-16T16:00:00-03:00', 2, '2026-10-19T09:00:00-03:00'],
  ['feriado na segunda-feira', '2026-10-09T16:00:00-03:00', 8, '2026-10-13T16:00:00-03:00'],
  ['entrada em feriado', '2026-10-12T10:00:00-03:00', 8, '2026-10-13T17:00:00-03:00'],
  ['feriado estadual', '2026-07-07T16:00:00-03:00', 2, '2026-07-09T09:00:00-03:00'],
  ['feriado móvel', '2026-04-02T16:00:00-03:00', 2, '2026-04-06T09:00:00-03:00'],
  ['virada do ano', '2026-12-31T16:00:00-03:00', 2, '2027-01-04T09:00:00-03:00'],
  ['precisão de segundos e milissegundos', '2026-10-13T16:30:20.125-03:00', 1, '2026-10-14T08:30:20.125-03:00']
];
for (const [nome, inicio, horas, esperado] of casos) {
  test('somarHorasUteis: ' + nome, () => {
    const fim = cal.somarHorasUteis(inicio, horas);
    assert.equal(fim.toISOString(), new Date(esperado).toISOString());
    assert.ok(Math.abs(cal.horasUteis(inicio, fim) - horas) < 1e-9);
  });
}

test('zero retorna o mesmo instante e preserva o Date original fora do expediente', () => {
  const inicio = new Date('2026-10-12T22:14:05.567-03:00');
  const original = inicio.getTime();
  const fim = cal.somarHorasUteis(inicio, 0);
  assert.notEqual(fim, inicio);
  assert.equal(fim.getTime(), original);
  assert.equal(inicio.getTime(), original);
  assert.equal(cal.somarHorasUteis(original, 0).getTime(), original);
});

test('usa expediente e feriados adicionais anuais/avulsos do próprio calendário', () => {
  const c = criarCalendario({ expediente: '07:00-10:00,14:00-17:00', feriadosExtra: '10-14,2026-10-15' });
  const inicio = '2026-10-13T16:00:00-03:00';
  const fim = c.somarHorasUteis(inicio, 8);
  assert.equal(fim.toISOString(), new Date('2026-10-19T08:00:00-03:00').toISOString());
  assert.equal(c.horasUteis(inicio, fim), 8);
});

test('exportação padrão disponibiliza a mesma operação', () => {
  assert.equal(typeof somarHorasUteis, 'function');
  assert.equal(somarHorasUteis('2026-10-12T22:00:00Z', 0).toISOString(), '2026-10-12T22:00:00.000Z');
});

test('rejeita início ausente, inválido e tipos sujeitos a coerção acidental', () => {
  for (const inicio of [null, undefined, '', 'data inválida', new Date(NaN), NaN, Infinity, true, [], {}]) {
    assert.throws(() => cal.somarHorasUteis(inicio, 0), /Início inválido/);
  }
});

test('rejeita duração inválida ou excessiva sem convertê-la em prazo imediato', () => {
  for (const horas of [-1, NaN, Infinity, -Infinity, null, undefined, '8', true, {}]) {
    assert.throws(() => cal.somarHorasUteis('2026-10-13T08:00:00-03:00', horas), /Horas úteis/);
  }
  assert.throws(() => cal.somarHorasUteis('2026-10-13T08:00:00-03:00', Number.MAX_VALUE), /fora do limite/);
});

test('não calcula prazo ambíguo com faixas de expediente sobrepostas', () => {
  const c = criarCalendario({ expediente: '08:00-12:00,11:00-17:00' });
  assert.throws(() => c.somarHorasUteis('2026-10-13T08:00:00-03:00', 8), /faixas sobrepostas/);
});
