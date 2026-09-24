'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const email = require('../relatorio-email');
const R = require('../reports');

const H = s => new Date(s + ':00-03:00');
const PESOS = { 'CV-Urbano': { descricao: 'Compra e Venda (urbano)', peso: 1, horas_referencia: 4 } };
function rel() {
  const r = R.calcular({
    tipo: 'semanal',
    periodo: { inicio: H('2026-09-21T00:00'), fim: H('2026-09-28T00:00'), inicioISO: '2026-09-21', fimISO: '2026-09-27' },
    escreventes: [{ login: 'x', nome: 'Lara <script>alert(1)</script>' }],
    pesos: PESOS,
    conclusoes: [{ escrevente: 'x', tipo_ato: 'CV-Urbano', horas_ativas: 3.25, horas_mesa: 10.5, retornos: 1,
      reaberturas: 0, historico_completo: true }]
  });
  r.pesos = PESOS;
  return r;
}

test('destinatários: sem RELATORIO_EMAIL_PARA é homologação para o endereço de teste', () => {
  const antes = process.env.RELATORIO_EMAIL_PARA;
  try {
    delete process.env.RELATORIO_EMAIL_PARA;
    assert.deepEqual(email.destinatarios(), { para: ['sergiolagofula2@gmail.com'], homologacao: true });
    process.env.RELATORIO_EMAIL_PARA = 'tabeliao@exemplo.com, substituta@exemplo.com';
    assert.deepEqual(email.destinatarios(), { para: ['tabeliao@exemplo.com', 'substituta@exemplo.com'], homologacao: false });
  } finally {
    if (antes === undefined) delete process.env.RELATORIO_EMAIL_PARA; else process.env.RELATORIO_EMAIL_PARA = antes;
  }
});

test('assunto com período e marca de homologação', () => {
  assert.equal(email.assunto(rel(), true), '[HOMOLOGAÇÃO] Relatório semanal das escreventes · 21/09 a 27/09/2026');
  assert.equal(email.assunto(rel(), false), 'Relatório semanal das escreventes · 21/09 a 27/09/2026');
});

test('HTML: identidade CN2O, números em pt-BR, conteúdo escapado, faixa de homologação', () => {
  const h = email.html(rel(), { homologacao: true });
  assert.match(h, /^<!doctype html>/);
  assert.match(h, /#202A3A/);                        // petróleo
  assert.match(h, /#631325/);                        // rubi
  assert.match(h, /HOMOLOGAÇÃO/);
  assert.match(h, /3,3 h/);                          // 3,25 → uma casa, vírgula
  assert.ok(!h.includes('<script>alert(1)'));
  assert.match(h, /Lara &lt;script&gt;/);
  assert.ok(!email.html(rel(), { homologacao: false }).includes('enviado somente para o endereço de teste'));
});

test('CSV: BOM, separador ;, decimal com vírgula, link do cartão, campos com ; entre aspas', () => {
  const out = email.csv([{ escrevente: 'x', protocolo: 1400, tipo_ato: 'CV-Urbano', horas_mesa: 10.5, horas_ativas: 3.25,
    retornos: 1, reaberturas: 0, historico_completo: true, card_short: 'abc', concluido_em: H('2026-09-24T10:00') }],
  PESOS, { x: 'Lara; da Silva' });
  assert.ok(out.startsWith('﻿escrevente;protocolo;tipo_ato;'));
  const linha = out.split('\r\n')[1].split(';');
  assert.equal(linha[0], '"Lara');                    // o nome com ; veio entre aspas
  assert.match(out, /"Lara; da Silva";1400;CV-Urbano;Compra e Venda \(urbano\);1;/);
  assert.match(out, /;10,5;3,25;/);
  assert.match(out, /24\/09\/2026, 10:00:00/);
  assert.match(out, /https:\/\/trello\.com\/c\/abc/);
});

test('envio sem provedor configurado falha com mensagem clara', async () => {
  const guard = ['RELATORIO_EMAIL_PROVEDOR', 'RELATORIO_EMAIL_WEBAPP_URL', 'RELATORIO_EMAIL_SECRET', 'RESEND_API_KEY'];
  const antes = Object.fromEntries(guard.map(k => [k, process.env[k]]));
  try {
    guard.forEach(k => delete process.env[k]);
    assert.equal(email.configurado(), false);
    await assert.rejects(email.enviar({ para: ['a@b'], assunto: 'x', html: '' }), /não configurado/);
  } finally {
    for (const [k, v] of Object.entries(antes)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
