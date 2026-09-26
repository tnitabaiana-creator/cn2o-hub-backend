'use strict';
// v1.39.1 — segurança, pacote A: primeiro acesso com código, força bruta, resposta única,
// hash de senha e de token. Banco simulado em memória; o roteador é o de verdade.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const auth = require('../auth');
const limites = require('../limites');
const db = require('../db');

// ---------------------------------------------------------------- banco simulado
const U = {};
const sessoes = new Map();
const chamadas = { gravarSenha: [] };
db.pool.query = async () => ({ rows: [] });                // a trilha de auditoria grava aqui (e engole)
db.buscarUsuario = async login => U[String(login || '').trim().toLowerCase()] || null;
db.gravarSenha = async (login, hash) => { chamadas.gravarSenha.push(login); U[login].senha_hash = hash; };
db.criarSessao = async (token, login) => { sessoes.set(auth.hashToken(token), login); };
db.encerrarSessao = async token => { sessoes.delete(auth.hashToken(token)); };
db.encerrarSessoesDe = async login => { for (const [k, v] of sessoes) if (v === login) sessoes.delete(k); };
db.definirSenhaComCodigo = async (login, codigoHash, senhaHash) => {
  const u = U[login];
  if (!u || u.senha_hash || !u.codigo_hash || u.codigo_hash !== codigoHash || !(u.codigo_expira > Date.now())) return null;
  u.senha_hash = senhaHash; u.codigo_hash = null; u.codigo_expira = null;
  return { login: u.login, nome: u.nome, cargo: u.cargo };
};
const pessoa = (login, o) => { U[login] = Object.assign({ login, nome: login, cargo: 'Escrevente', senha_hash: null, codigo_hash: null, codigo_expira: null }, o); };

let base, srv;
test.before(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(require('../acesso').router);
  srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  base = 'http://127.0.0.1:' + srv.address().port;
});
test.after(() => srv.close());
test.beforeEach(() => { limites.zerarTudo(); for (const k of Object.keys(U)) delete U[k]; sessoes.clear(); chamadas.gravarSenha = []; });

const post = (rota, corpo, ip = '10.0.0.1') => fetch(base + rota, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(corpo)
}).then(async r => ({ status: r.status, corpo: await r.json(), retry: r.headers.get('retry-after') }));

// ---------------------------------------------------------------- hash e código
test('senha: formato novo (scrypt OWASP), formato antigo aceito e marcado para migrar', async () => {
  const h = await auth.hashSenha('segredo-forte-1');
  assert.match(h, /^s2\$16384\$8\$5\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.deepEqual(await auth.verificaSenha('segredo-forte-1', h), { ok: true, atualizar: false });
  assert.equal((await auth.verificaSenha('errada', h)).ok, false);
  const sal = crypto.randomBytes(16).toString('hex');
  const antigo = `${sal}:${crypto.scryptSync('senha-velha', sal, 64).toString('hex')}`;
  assert.deepEqual(await auth.verificaSenha('senha-velha', antigo), { ok: true, atualizar: true });
  assert.equal((await auth.verificaSenha('outra', antigo)).ok, false);
  assert.equal((await auth.verificaSenha('x', auth.HASH_FALSO)).ok, false);
  assert.equal((await auth.verificaSenha('x', 'lixo')).ok, false);
});

test('código de acesso: 10 caracteres sem ambíguos, uso tolerante a caixa e hífen', () => {
  const c = auth.novoCodigo();
  assert.match(c, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
  assert.equal(auth.hashCodigo(c.toLowerCase().replace('-', ' ')), auth.hashCodigo(c));
  assert.notEqual(auth.hashCodigo(c), auth.hashCodigo(auth.novoCodigo()));
  assert.equal(auth.hashToken('abc').length, 64);
});

// ---------------------------------------------------------------- o ataque que motivou o pacote
test('tomada de conta: conta sem senha NÃO aceita senha nova sem o código do Tabelião', async () => {
  pessoa('cesar.bravo', { cargo: 'Tabelião' });
  const r = await post('/definir-senha', { login: 'cesar.bravo', senha: 'invasor-123' });
  assert.equal(r.status, 401);
  assert.equal(U['cesar.bravo'].senha_hash, null);
  assert.equal(sessoes.size, 0);
  const l = await post('/login', { login: 'cesar.bravo' });
  assert.equal(l.status, 401);
  assert.equal(l.corpo.primeiro_acesso, undefined);           // o /login não entrega mais quem está sem senha
});

test('primeiro acesso: código certo cria a senha e entra; código só vale uma vez e vence', async () => {
  const codigo = auth.novoCodigo();
  pessoa('lara.silva', { codigo_hash: auth.hashCodigo(codigo), codigo_expira: Date.now() + 3600e3 });
  assert.equal((await post('/definir-senha', { login: 'lara.silva', codigo: 'AAAAA-BBBBB', senha: 'minha-senha-9' })).status, 401);
  const r = await post('/definir-senha', { login: 'Lara.Silva ', codigo: codigo.toLowerCase(), senha: 'minha-senha-9' });
  assert.equal(r.status, 200);
  assert.match(r.corpo.token, /^[0-9a-f]{64}$/);
  assert.ok(sessoes.has(auth.hashToken(r.corpo.token)));     // no "banco" fica só o hash do token
  assert.ok(!sessoes.has(r.corpo.token));
  assert.equal((await post('/definir-senha', { login: 'lara.silva', codigo, senha: 'outra-senha-9' })).status, 401);
  assert.equal((await post('/login', { login: 'lara.silva', senha: 'minha-senha-9' })).status, 200);

  pessoa('jonas.aragao', { codigo_hash: auth.hashCodigo(codigo), codigo_expira: Date.now() - 1000 });
  assert.equal((await post('/definir-senha', { login: 'jonas.aragao', codigo, senha: 'senha-longa-1' })).status, 401);
});

test('primeiro acesso: senha curta ou com o nome do usuário é recusada', async () => {
  const codigo = auth.novoCodigo();
  pessoa('camily.oliveira', { codigo_hash: auth.hashCodigo(codigo), codigo_expira: Date.now() + 3600e3 });
  assert.equal((await post('/definir-senha', { login: 'camily.oliveira', codigo, senha: 'curta' })).status, 400);
  assert.equal((await post('/definir-senha', { login: 'camily.oliveira', codigo, senha: 'Camily2026!' })).status, 400);
  assert.equal(U['camily.oliveira'].senha_hash, null);
});

test('resposta única: inexistente, sem senha e senha errada dão o mesmo 401 e a mesma mensagem', async () => {
  pessoa('josi.silva', { senha_hash: await auth.hashSenha('certa-da-josi') });
  pessoa('milvo.neto');
  const a = await post('/login', { login: 'ninguem.aqui', senha: 'x-qualquer' });
  const b = await post('/login', { login: 'milvo.neto', senha: 'x-qualquer' });
  const c = await post('/login', { login: 'josi.silva', senha: 'x-qualquer' });
  for (const r of [a, b, c]) { assert.equal(r.status, 401); assert.deepEqual(r.corpo, { erro: 'usuário ou senha inválidos' }); }
});

test('força bruta: 5 erros no mesmo login bloqueiam 15 min (429), inclusive a senha certa', async () => {
  pessoa('romenia.oliveira', { senha_hash: await auth.hashSenha('a-senha-certa') });
  for (let i = 0; i < 5; i++) assert.equal((await post('/login', { login: 'romenia.oliveira', senha: 'chute-' + i }, '10.0.0.' + i)).status, 401);
  const r = await post('/login', { login: 'romenia.oliveira', senha: 'a-senha-certa' }, '10.9.9.9');
  assert.equal(r.status, 429);
  assert.ok(Number(r.retry) > 800 && Number(r.retry) <= 900);
  assert.match(r.corpo.erro, /muitas tentativas/);
  pessoa('lara.silva', { senha_hash: await auth.hashSenha('senha-da-lara') });
  assert.equal((await post('/login', { login: 'lara.silva', senha: 'senha-da-lara' }, '10.9.9.9')).status, 200);   // outro login segue livre
});

test('força bruta: 20 erros do mesmo IP (logins variados) bloqueiam aquele IP', async () => {
  for (let i = 0; i < 20; i++) await post('/login', { login: 'x' + i + '.y', senha: 'z' }, '203.0.113.7');
  pessoa('lara.silva', { senha_hash: await auth.hashSenha('senha-da-lara') });
  assert.equal((await post('/login', { login: 'lara.silva', senha: 'senha-da-lara' }, '203.0.113.7')).status, 429);
  assert.equal((await post('/login', { login: 'lara.silva', senha: 'senha-da-lara' }, '198.51.100.2')).status, 200);
});

test('limites: bloqueio vence sozinho; acerto zera o contador do login', () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) limites.falhou(['login:a.b'], t0);
  assert.ok(limites.bloqueado(['login:a.b'], t0 + 1000) > 0);
  assert.equal(limites.bloqueado(['login:a.b'], t0 + limites.BLOQUEIO_MS + 1), 0);
  for (let i = 0; i < 4; i++) limites.falhou(['login:c.d'], t0);
  limites.limpar('login:c.d');
  limites.falhou(['login:c.d'], t0);
  assert.equal(limites.bloqueado(['login:c.d'], t0), 0);
});

test('senha em formato antigo: login certo migra o hash para o formato novo', async () => {
  const sal = crypto.randomBytes(16).toString('hex');
  pessoa('cesar.bravo', { senha_hash: `${sal}:${crypto.scryptSync('senha-antiga-1', sal, 64).toString('hex')}` });
  assert.equal((await post('/login', { login: 'cesar.bravo', senha: 'senha-antiga-1' })).status, 200);
  assert.deepEqual(chamadas.gravarSenha, ['cesar.bravo']);
  assert.match(U['cesar.bravo'].senha_hash, /^s2\$/);
  assert.equal((await post('/login', { login: 'cesar.bravo', senha: 'senha-antiga-1' })).status, 200);
});

test('emergência: HUB_CODIGO_ADMIN vale só para administrador e só com 16+ caracteres', async () => {
  const antes = process.env.HUB_CODIGO_ADMIN;
  try {
    pessoa('cesar.bravo', { cargo: 'Tabelião', senha_hash: await auth.hashSenha('esquecida-123') });
    pessoa('lara.silva');
    process.env.HUB_CODIGO_ADMIN = 'curto';
    assert.equal((await post('/definir-senha', { login: 'cesar.bravo', codigo: 'curto', senha: 'nova-do-tabeliao' })).status, 401);
    process.env.HUB_CODIGO_ADMIN = 'EMERGENCIA-2026-XYZ';
    assert.equal((await post('/definir-senha', { login: 'lara.silva', codigo: 'EMERGENCIA-2026-XYZ', senha: 'tentativa-xyz-1' })).status, 401);
    const r = await post('/definir-senha', { login: 'cesar.bravo', codigo: 'emergencia 2026 xyz', senha: 'nova-do-tabeliao' });
    assert.equal(r.status, 200);
    assert.equal((await post('/login', { login: 'cesar.bravo', senha: 'nova-do-tabeliao' })).status, 200);
  } finally {
    if (antes === undefined) delete process.env.HUB_CODIGO_ADMIN; else process.env.HUB_CODIGO_ADMIN = antes;
  }
});

test('sair: o token deixa de valer', async () => {
  pessoa('lara.silva', { senha_hash: await auth.hashSenha('senha-da-lara') });
  const r = await post('/login', { login: 'lara.silva', senha: 'senha-da-lara' });
  assert.equal(sessoes.size, 1);
  await fetch(base + '/logout', { method: 'POST', headers: { 'X-Auth-Token': r.corpo.token } });
  assert.equal(sessoes.size, 0);
});
