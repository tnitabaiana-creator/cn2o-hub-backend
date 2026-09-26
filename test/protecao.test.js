'use strict';
// v1.39.2 — segurança, pacote B: cabeçalhos, CORS só do Hub, erros sem detalhe interno,
// telefone mascarado, webhook do Trello só assinado, e corpo lido só depois do login.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const P = require('../protecao');

let base, srv;
test.before(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(P.cabecalhos);
  app.use(P.cors(['https://cn2o-hub.netlify.app']));
  app.get('/ok', (_req, res) => res.json({ ok: true }));
  app.post('/json', express.json({ limit: '1kb' }), (req, res) => res.json(req.body));
  app.get('/explode', () => { throw new Error('senha do banco: postgres://u:segredo@host'); });
  app.use(P.tratadorDeErros);
  srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  base = 'http://127.0.0.1:' + srv.address().port;
});
test.after(() => srv.close());

test('cabeçalhos de segurança em toda resposta, sem X-Powered-By', async () => {
  const r = await fetch(base + '/ok');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(r.headers.get('strict-transport-security'), /max-age=31536000/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(r.headers.get('content-security-policy'), /object-src 'none'/);
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('CORS: só o site do Hub; outro site não recebe permissão; sem Origin segue normal', async () => {
  const pre = o => fetch(base + '/ok', { method: 'OPTIONS', headers: { Origin: o, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-auth-token' } });
  const bom = await pre('https://cn2o-hub.netlify.app');
  assert.equal(bom.status, 204);
  assert.equal(bom.headers.get('access-control-allow-origin'), 'https://cn2o-hub.netlify.app');
  assert.match(bom.headers.get('access-control-allow-headers'), /X-Auth-Token/);
  const mau = await pre('https://site-malicioso.example');
  assert.equal(mau.headers.get('access-control-allow-origin'), null);
  const semOrigem = await fetch(base + '/ok');
  assert.equal(semOrigem.status, 200);
  assert.equal(semOrigem.headers.get('access-control-allow-origin'), null);
  assert.match(semOrigem.headers.get('vary') || '', /Origin/);
  assert.deepEqual(P.origensPermitidas('https://a.example/, https://b.example'), ['https://a.example', 'https://b.example']);
  assert.deepEqual(P.origensPermitidas(''), ['https://cn2o-hub.netlify.app']);
});

test('erros: nada de detalhe interno nem pilha; JSON malformado = 400; grande demais = 413', async () => {
  const antes = console.error; console.error = () => {};
  try {
    const r = await fetch(base + '/explode');
    assert.equal(r.status, 500);
    const t = await r.text();
    assert.deepEqual(JSON.parse(t), { erro: 'falha interna — tente de novo' });
    assert.ok(!/segredo|postgres|at |\.js:/.test(t));
  } finally { console.error = antes; }
  const mal = await fetch(base + '/json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":' });
  assert.equal(mal.status, 400);
  assert.deepEqual(await mal.json(), { erro: 'requisição inválida' });
  const grande = await fetch(base + '/json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'y'.repeat(5000) }) });
  assert.equal(grande.status, 413);
});

test('telefone mascarado: só os 4 últimos dígitos', () => {
  assert.equal(P.mascaraTel('+55 (79) 99812-3456'), '•••••••••3456');
  assert.equal(P.mascaraTel('123'), '••••');
  assert.equal(P.mascaraTel(null), '');
});

test('webhook do Trello: re-hidrata só com assinatura válida (ou sem segredo, só nos quadros da casa)', () => {
  const casa = ['q1', 'q2'];
  assert.equal(P.podeReidratar('ok', 'qualquer', casa), true);
  assert.equal(P.podeReidratar('invalida', 'q1', casa), false);      // forjado: nada
  assert.equal(P.podeReidratar('sem-segredo', 'q1', casa), true);
  assert.equal(P.podeReidratar('sem-segredo', 'de-fora', casa), false);
  assert.equal(P.podeReidratar('sem-segredo', undefined, casa), false);
});

test('rotas do Hub: o corpo (até 24 MB) só é lido DEPOIS do login', () => {
  const hub = fs.readFileSync(path.join(__dirname, '..', 'hub.js'), 'latin1');
  assert.doesNotMatch(hub, /(jsonIA|jsonMural),\s*exigeSessao/);
  assert.match(hub, /exigeSessao, jsonIA/);
  assert.match(hub, /exigeSessao, exigeAdmin, jsonMural/);
});

test('servidor: rotas públicas antigas fecharam (HUB_KEY sem uso, WhatsApp só do Tabelião)', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(s, /app\.post\('\/admin\/resetar-senha'/);
  assert.doesNotMatch(s, /chaveAdminOk|X-Admin-Key/);
  assert.match(s, /app\.get\('\/whats\/status', exigeSessao, exigeAdminHub/);
  assert.match(s, /app\.post\('\/whats\/testar', exigeSessao, exigeAdminHub/);
  assert.doesNotMatch(s, /Access-Control-Allow-Origin', '\*'/);
});
