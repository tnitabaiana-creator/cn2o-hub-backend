'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createHash, randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { Pool } = require('pg');
const storage = require('../gestao-relatorios-db');
const { createRouter } = require('../gestao-relatorios');
const { lerBase64 } = require('../scripts/importar-produtividade');
const html = Buffer.from('\ufeff<!doctype html>\r\n<html lang="pt-BR"><body>Relatório fictício<script>window.meses={};</script></body></html>\r\n');
const sha = createHash('sha256').update(html).digest('hex');
const meses = { '2026-10': { nome: 'Outubro fictício', linhas: [{ cliente: 'Pessoa fictícia', valor: 125.5, atos: 2 }], encerrado: false } };
const erro = (fn, status = 400) => assert.throws(fn, e => e.status === status);

test('HTML original conserva bytes UTF-8, BOM, CRLF e SHA-256 sem execução', () => {
  const v = storage.validarHTML(html);
  assert.equal(v.dados, html); assert.equal(v.sha256, sha);
  erro(() => storage.validarHTML(Buffer.from('<script>x</script>')));
  erro(() => storage.validarHTML(Buffer.from('<html>\0</html>')));
  erro(() => storage.validarHTML(Buffer.from([0xff, 0xfe])));
  erro(() => storage.validarHTML(Buffer.alloc(storage.MAX_BYTES + 1)), 413);
});
test('estado conserva valores e aceita somente objeto JSON finito sem chaves perigosas', () => {
  assert.deepEqual(JSON.parse(storage.validarMeses(meses)), meses);
  for (const v of [null, [], '', { v: NaN }, { v: Infinity }, { v: undefined }, { v: new Date() }]) erro(() => storage.validarMeses(v));
  for (const k of ['__proto__', 'constructor', 'prototype']) erro(() => storage.validarMeses(JSON.parse('{"x":{"' + k + '":{}}}')));
  erro(() => storage.validarMeses({ x: '\ud800' }));
  const circular = {}; circular.x = circular; erro(() => storage.validarMeses(circular));
});
test('estado limita bytes, profundidade e revisão para evitar perda por overflow', () => {
  erro(() => storage.validarMeses({ grande: 'a'.repeat(storage.MAX_BYTES) }), 413);
  const profundo = {}; let v = profundo; for (let i = 0; i < 25; i++) v = v.x = {};
  erro(() => storage.validarMeses(profundo));
  for (const r of [0, -1, '1', 1.1, null, 2147483647]) erro(() => storage.validarRevisao(r));
  assert.equal(storage.validarRevisao(1), 1);
});
test('stdin base64 preserva o original entre fragmentos e rejeita codificação ambígua', async () => {
  const b = html.toString('base64');
  assert.deepEqual(await lerBase64(Readable.from([b.slice(0, 15), b.slice(15)])), html);
  for (const dado of ['', b + '\n', '!!!!', 'AB==']) await assert.rejects(lerBase64(Readable.from([dado])), e => e.status === 400);
  await assert.rejects(lerBase64(Readable.from(['a'.repeat(Math.ceil(storage.MAX_BYTES / 3) * 4 + 1)])), e => e.status === 413);
});

async function servidor(t, opcoes = {}) {
  const app = express();
  app.use('/hub/gestao', createRouter({ session: async token => token === 'admin' ? { login: 'admin', admin: true } : token === 'equipe' ? { login: 'equipe' } : null,
    ehAdmin: u => u.admin === true, initialize: async () => {}, ...opcoes }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return (sufixo = '', token, opts = {}) => fetch(`http://127.0.0.1:${server.address().port}/hub/gestao/produtividade-escrituras${sufixo}`,
    { ...opts, headers: { ...(token ? { 'X-Auth-Token': token } : {}), ...(opts.headers || {}) } });
}
const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
test('rotas privadas negam 401 sem sessão e 403 à equipe antes de ler banco ou corpo', async t => {
  let acessos = 0;
  const req = await servidor(t, { initialize: () => { acessos++; throw new Error('não deveria iniciar'); } });
  for (const caminho of ['', '/estado']) for (const token of [undefined, 'invalido', 'equipe']) {
    const r = await req(caminho, token, caminho ? post('{') : {});
    assert.equal(r.status, token === 'equipe' ? 403 : 401);
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    assert.match(r.headers.get('content-type'), /application\/json/);
  }
  assert.equal(acessos, 0);
});
test('somente admin recebe JSON com HTML original e metadados, nunca text/html', async t => {
  const req = await servidor(t, { pool: { query: async () => ({ rows: [{ html, sha256: sha, meses: null, revisao: 1, atualizado_em: '2026-10-08T12:00:00.000Z' }] }) } });
  const r = await req('', 'admin'); assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await r.json(), { html: html.toString('utf8'), sha256: sha, meses: null, revisao: 1, atualizadoEm: '2026-10-08T12:00:00.000Z' });
});
test('admin recebe 404 se documento não foi importado e erro genérico em falha SQL', async t => {
  let falhar = false;
  const req = await servidor(t, { pool: { query: async () => { if (falhar) throw new Error('SEGREDO DE CLIENTE'); return { rows: [] }; } } });
  assert.equal((await req('', 'admin')).status, 404); falhar = true;
  const r = await req('', 'admin'); assert.equal(r.status, 503); assert.doesNotMatch(await r.text(), /SEGREDO/);
});
test('hash divergente bloqueia a leitura de bytes corrompidos', async t => {
  const req = await servidor(t, { pool: { query: async () => ({ rows: [{ html, sha256: '0'.repeat(64) }] }) } });
  const r = await req('', 'admin'); assert.equal(r.status, 503); assert.doesNotMatch(await r.text(), /fictício/);
});
test('POST valida JSON, campos permitidos, revisão, chaves perigosas e limite antes de persistir', async t => {
  let acessos = 0;
  const req = await servidor(t, { pool: { connect: () => { acessos++; throw new Error('não deveria conectar'); } } });
  for (const corpo of ['{', { meses, revisao: 0 }, { meses: [], revisao: 1 }, { meses, revisao: 1, html: '<html>' }, '{"meses":{"__proto__":{}},"revisao":1}']) {
    assert.equal((await req('/estado', 'admin', post(corpo))).status, 400);
  }
  assert.equal((await req('/estado', 'admin', post({ meses: { grande: 'x'.repeat(storage.MAX_BYTES) }, revisao: 1 }))).status, 413);
  assert.equal((await req('/estado', 'admin', post('x'.repeat(storage.MAX_BYTES + 5000)))).status, 413);
  assert.equal(acessos, 0);
});
test('router é fechado por padrão sem política ehAdmin', async t => {
  const req = await servidor(t, { ehAdmin: undefined });
  assert.equal((await req('', 'admin')).status, 403);
});

test('PostgreSQL: importação, HTTP, concorrência e histórico íntegro', { skip: !process.env.GESTAO_TEST_DATABASE_URL }, async t => {
  const admin = new Pool({ connectionString: process.env.GESTAO_TEST_DATABASE_URL, max: 1 });
  const schema = 'gestao_test_' + randomUUID().replace(/-/g, '');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.GESTAO_TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 4 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const v1 = await storage.importar(pool, { dados: html, autor: 'teste.importador' });
  assert.equal(v1.revisao, 1); assert.equal(v1.alterado, true);
  const req = await servidor(t, { pool, initialize: () => storage.init(pool) });
  await t.test('GET inicial devolve original byte a byte e meses null', async () => {
    const r = await req('', 'admin'); assert.equal(r.status, 200);
    const d = await r.json(); assert.deepEqual(Buffer.from(d.html), html); assert.equal(d.sha256, sha); assert.equal(d.meses, null);
  });
  await t.test('POST persiste estado, autoria e revisão; reabertura recupera os dados', async () => {
    const r = await req('/estado', 'admin', post({ meses, revisao: 1 })); assert.equal(r.status, 200);
    assert.equal((await r.json()).revisao, 2);
    const salvo = await (await req('', 'admin')).json(); assert.deepEqual(salvo.meses, meses); assert.equal(salvo.revisao, 2);
    assert.equal((await pool.query('SELECT criado_por FROM gestao_relatorio_estados WHERE revisao=2')).rows[0].criado_por, 'admin');
  });
  await t.test('reimportar mesmo hash não apaga meses nem cria revisão', async () => {
    const r = await storage.importar(pool, { dados: html, autor: 'teste.importador' });
    assert.equal(r.alterado, false); assert.equal(r.revisao, 2);
    assert.deepEqual((await storage.obter(pool)).meses, meses);
  });
  await t.test('duas gravações concorrentes: somente uma confirma e a outra recebe 409', async () => {
    const rs = await Promise.all([req('/estado', 'admin', post({ meses: { ...meses, marca: 'a' }, revisao: 2 })), req('/estado', 'admin', post({ meses: { ...meses, marca: 'b' }, revisao: 2 }))]);
    assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
    assert.equal((await rs.find(r => r.status === 409).json()).codigo, 'REVISAO_DESATUALIZADA');
    assert.equal((await storage.obter(pool)).revisao, 3);
  });
  const html2 = Buffer.from(html.toString('utf8').replace('Relatório fictício', 'Novo relatório fictício'));
  await t.test('novo HTML sem autorização é rejeitado sem alterações', async () => {
    await assert.rejects(storage.importar(pool, { dados: html2, autor: 'teste.importador' }), e => e.status === 409 && e.codigo === 'ORIGINAL_DIVERGENTE');
    assert.equal((await storage.obter(pool)).sha256, sha);
    assert.equal((await storage.obter(pool)).revisao, 3);
  });
  await t.test('substituição explícita preserva ambos os originais e todos os estados', async () => {
    const r = await storage.importar(pool, { dados: html2, autor: 'teste.importador', substituir: true });
    assert.equal(r.revisao, 4); assert.equal((await storage.obter(pool)).meses, null);
    const originais = (await pool.query('SELECT * FROM gestao_relatorio_originais ORDER BY criado_em')).rows;
    assert.equal(originais.length, 2); assert.deepEqual(originais[0].html, html); assert.equal(originais[0].sha256, sha);
    const estados = (await pool.query('SELECT * FROM gestao_relatorio_estados ORDER BY revisao')).rows;
    assert.equal(estados.length, 4); assert.deepEqual(estados[1].meses, meses);
    assert.equal(estados[0].meses, null); assert.equal(estados[3].origem, 'importacao');
  });
});
