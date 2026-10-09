'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Pool } = require('pg');
const express = require('express');
const S = require('../livro-caixa-db');
const { createRouter } = require('../livro-caixa');
const body = (revision = 0) => ({ revisao_base: revision, total_despesas_centavos: 10000, fonte: 'Livro-caixa fictício conferido pelo titular' });
const anexo = () => ({ nome: 'livro-ficticio.pdf', tipo: 'application/pdf', base64: Buffer.from('%PDF-1.7\nDocumento fictício').toString('base64') });
const falha = (fn, status = 400) => assert.throws(fn, e => e.status === status);
test('livro aplica IR apenas no saldo positivo e distingue ausente de zero confirmado', () => {
  const rec = S.receitaDoMes({ dados: { total: 1000 } });
  assert.equal(rec.receita_liquida, 704.31);
  assert.equal(S.projetar(rec, S.despesasDoMes(null)).saldo, null);
  assert.equal(S.projetar(S.receitaDoMes(null), { total_centavos: 0 }).saldo, null);
  assert.deepEqual(S.projetar(rec, { total_centavos: 10000 }).centavos, { saldo: 60431, ir_projetado: 16619, liquido_projetado: 43812 });
  assert.deepEqual(S.projetar(rec, { total_centavos: 80000 }).centavos, { saldo: -9569, ir_projetado: 0, liquido_projetado: -9569 });
  assert.equal(S.projetar(rec, { total_centavos: 0 }).saldo, 704.31);
});
test('despesas exigem confirmação em centavos, fonte e revisão; não aceitam Controle de Despesas', () => {
  assert.equal(S.validar('2026-10', body()).total_despesas_centavos, 10000);
  for (const edit of [{ total_despesas_centavos: null }, { total_despesas_centavos: -1 }, { total_despesas_centavos: 1.2 }, { fonte: '' }, { revisao_base: '0' }, { despesas_controle: true }, { fonte: 'x\ny' }]) falha(() => S.validar('2026-10', { ...body(), ...edit }));
  falha(() => S.validar('2026-13', body()));
  assert.equal(S.validar('2026-10', { ...body(), total_despesas_centavos: 0 }).total_despesas_centavos, 0);
});
test('anexos mantêm bytes/hash, conferem formato e limite de 10MiB', () => {
  const a = anexo(), b = S.validarAnexo(a);
  assert.equal(b.bytes.toString('base64'), a.base64);
  assert.equal(b.sha256, createHash('sha256').update(b.bytes).digest('hex'));
  falha(() => S.validarAnexo({ ...a, nome: '../a.pdf' }));
  falha(() => S.validarAnexo({ ...a, tipo: 'text/html' }));
  falha(() => S.validarAnexo({ ...a, base64: Buffer.from('<html>x</html>').toString('base64') }));
  falha(() => S.validarAnexo({ nome: 'a.csv', tipo: 'text/csv', base64: Buffer.from('<script>x</script>').toString('base64') }));
  falha(() => S.validarAnexo({ ...a, base64: a.base64 + '\n' }));
  const limite = Buffer.alloc(S.MAX_BYTES, 32); limite.write('%PDF-');
  assert.equal(S.validarAnexo({ ...a, base64: limite.toString('base64') }).bytes.length, S.MAX_BYTES);
  falha(() => S.validarAnexo({ ...a, base64: Buffer.alloc(S.MAX_BYTES + 1).toString('base64') }), 413);
});
async function servidor(t, pool, initialize = async () => {}) {
  const app = express();
  app.use('/hub/livro-caixa', createRouter({ pool, initialize, session: async token => token === 'cesar' ? { login: 'cesar.bravo' } : token ? { login: token, admin: true } : null }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return (rota = '', token = 'cesar', valor) => fetch(`http://127.0.0.1:${server.address().port}/hub/livro-caixa${rota}`, {
    method: valor === undefined ? 'GET' : 'POST', headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' }, body: valor === undefined ? undefined : typeof valor === 'string' ? valor : JSON.stringify(valor)
  });
}
test('somente César acessa todas as rotas, inclusive outro admin não acessa bytes', async t => {
  let acessos = 0; const req = await servidor(t, {}, async () => { acessos++; throw Error('SEGREDO'); });
  for (const rota of ['', '/meses/2026-10/historico', '/anexos/' + randomUUID(), '/meses/2026-10']) {
    for (const token of ['', 'outro.admin', 'CESAR.BRAVO']) {
      const r = await req(rota, token, rota.endsWith('/2026-10') ? '{' : undefined);
      assert.equal(r.status, token ? 403 : 401); assert.equal(r.headers.get('cache-control'), 'private, no-store');
    }
  }
  assert.equal(acessos, 0);
  const r = await req(); assert.equal(r.status, 503); assert.doesNotMatch(await r.text(), /SEGREDO/);
});
test('PostgreSQL: isolamento, versão, conflito, anexo privado e auditoria', { skip: !process.env.GESTAO_TEST_DATABASE_URL }, async t => {
  const admin = new Pool({ connectionString: process.env.GESTAO_TEST_DATABASE_URL, max: 1 });
  const schema = 'livro_test_' + randomUUID().replace(/-/g, '');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.GESTAO_TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 4 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query('CREATE TABLE produtividade_mes(ano integer,mes integer,dados jsonb,fonte text,importado_em timestamptz)');
  await pool.query("INSERT INTO produtividade_mes VALUES(2026,10,'{\"total\":1000,\"atos\":10}','Pesquisa fictícia',now())");
  // Não existe tabela Controle de Despesas neste schema: nenhuma consulta depende dela.
  await S.init(pool); const req = await servidor(t, pool, () => S.init(pool));
  const inicial = await (await req()).json(); assert.equal(inicial.meses[0].despesas.total, null); assert.equal(inicial.meses[0].projecao.saldo, null);
  const a = anexo(), salvo = await req('/meses/2026-10', 'cesar', { ...body(), anexo: a });
  assert.equal(salvo.status, 200); const d = await salvo.json(); assert.equal(d.despesas.revisao, 1);
  assert.equal(d.projecao.saldo, 604.31); assert.equal(d.despesas.atualizado_por, 'cesar.bravo');
  const download = await req('/anexos/' + d.despesas.anexo.id); assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment;/); assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Buffer.from(await download.arrayBuffer()).toString('base64'), a.base64);
  const concorrentes = await Promise.all([req('/meses/2026-10', 'cesar', body(1)), req('/meses/2026-10', 'cesar', body(1))]);
  assert.deepEqual(concorrentes.map(r => r.status).sort(), [200, 409]);
  const historico = await (await req('/meses/2026-10/historico')).json(); assert.equal(historico.versoes.length, 2);
  assert.equal(historico.versoes[0].despesas.anexo.id, d.despesas.anexo.id);
  assert.equal(historico.versoes[0].receita_referencia.receita_liquida, 704.31);
  const removido = await (await req('/meses/2026-10', 'cesar', { ...body(2), anexo: null })).json(); assert.equal(removido.despesas.anexo, null);
  assert.equal((await req('/anexos/' + d.despesas.anexo.id)).status, 200); // histórico preservado
  assert.deepEqual((await pool.query('SELECT dados FROM produtividade_mes')).rows[0].dados, { total: 1000, atos: 10 });
  assert.equal((await req('/meses/2026-10', 'cesar', body(0))).status, 409);
  assert.equal((await req('/meses/2026-11', 'cesar', body())).status, 200);
  const meses = (await (await req()).json()).meses;
  assert.equal(meses[1].receita.status, 'ausente'); assert.equal(meses[1].projecao.ir_projetado, null);
  const before = (await pool.query('SELECT count(*)::int n FROM livro_caixa_versoes')).rows[0].n;
  assert.equal((await req('/meses/2026-10', 'cesar', { ...body(3), anexo: { ...a, nome: 'x.exe' } })).status, 400);
  assert.equal((await pool.query('SELECT count(*)::int n FROM livro_caixa_versoes')).rows[0].n, before);
});
