'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const express = require('express');
const { Readable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const S = require('../atos-lavrados-db');
const { createRouter } = require('../atos-lavrados');
const cli = require('../scripts/importar-atos-lavrados');
const ato = (n = 1, dia = '2026-06-15') => ({ minuta: String(n), protocolo: '001', livro: '795', folha: '51', documento: 'Escritura com Valor', data_lavratura: dia,
  status: 4, status_nome: 'Registrado(a)', originais: { Minuta: String(n), Data: dia.split('-').reverse().join('/'), 'U.criador': 'OPERADOR FICTÍCIO', observacao: '  conteúdo preservado\r\n' } });
const cobertura = (mes, ate, revisao_base = 0, dia_final_completo = true, corte_em = '2026-10-10T09:00:00-03:00') => ({ mes, ate, revisao_base, dia_final_completo, corte_em });
const lote = () => ({ operacao_id: randomUUID(), fonte: { sistema: 'Extra Digital', arquivo: 'fixture.csv', sha256: 'a'.repeat(64) },
  meses: [cobertura('2026-06', '2026-06-30')], registros: [ato()] });
const clone = x => JSON.parse(JSON.stringify(x));
const rejeita = (f, codigo) => assert.throws(f, e => e.status === 400 && (!codigo || e.codigo === codigo));

test('somente Registrado(a), com data civil válida e cobertura explícita', () => {
  for (const alterar of [p => p.registros[0].status = 3, p => p.registros[0].status_nome = 'Assinado', p => p.registros[0].data_lavratura = '2026-02-30',
    p => p.registros[0].data_lavratura = '2026-07-01', p => p.meses[0].ate = '2026-06-01', p => p.meses[0].mes = '2026-13',
    p => p.registros[0].minuta = '', p => p.registros[0].protocolo = '', p => p.registros[0].originais = {}, p => p.meses[0].revisao_base = -1]) {
    const p = lote(); alterar(p); rejeita(() => S.validarLote(p));
  }
});
test('chave usa cinco campos, não apenas protocolo, livro/folha ou nome do operador', () => {
  const p = lote(); p.registros.push(ato(2));
  assert.equal(S.validarLote(p).registros.length, 2);
  for (const k of ['minuta', 'protocolo', 'livro', 'folha', 'documento']) {
    const x = lote(), v = S.validarLote(x).registros[0].chave; x.registros[0][k] += 'X';
    assert.notEqual(S.validarLote(x).registros[0].chave, v, k);
  }
  p.registros.push(clone(p.registros[0])); rejeita(() => S.validarLote(p));
});
test('originais preservados e U.criador não vira responsável; hash do lote inclui conteúdo', () => {
  const p = lote(), r = S.validarLote(p);
  assert.deepEqual(r.conteudo, p); assert.deepEqual(r.registros[0].registro.originais, p.registros[0].originais);
  assert.equal(r.registros[0].registro.responsavel, undefined);
  p.registros[0].originais['U.criador'] = 'OUTRO OPERADOR';
  assert.notEqual(S.validarLote(p).sha256, r.sha256);
  assert.equal(S.validarLote(p).registros[0].chave, r.registros[0].chave);
});
test('protocolo vazio documentado conserva as cinco posições da chave e exige os outros quatro campos', () => {
  const p = lote(); p.registros[0].protocolo = ''; p.registros[0].originais.Protocolo = '';
  rejeita(() => S.validarLote(p));
  p.registros[0].pendencia_identificacao = ['protocolo_ausente_na_fonte'];
  const v = S.validarLote(p); assert.equal(v.registros[0].registro.protocolo, '');
  assert.deepEqual(v.registros[0].registro.originais, p.registros[0].originais);
  const falso = clone(p); falso.registros[0].originais.Protocolo = '123'; rejeita(() => S.validarLote(falso));
  for (const k of ['minuta', 'livro', 'folha', 'documento']) { const x = clone(p); x.registros[0][k] = ''; rejeita(() => S.validarLote(x)); }
});
test('identidade Documento+Minuta impede duplicação por correção de protocolo, livro ou folha', () => {
  const p = lote(); const anterior = clone(p.registros[0]); anterior.protocolo = ''; anterior.originais.Protocolo = '';
  anterior.pendencia_identificacao = ['protocolo_ausente_na_fonte']; p.registros.push(anterior);
  rejeita(() => S.validarLote(p));
  for (const k of ['protocolo', 'livro', 'folha']) { const x = lote(); const duplicado = clone(x.registros[0]); duplicado[k] += 'X'; x.registros.push(duplicado); rejeita(() => S.validarLote(x)); }
  p.registros[1].documento = 'Outro documento'; assert.equal(S.validarLote(p).registros.length, 2);
});
test('corte exige fuso e declaração explícita; dia civil usa America/Sao_Paulo', () => {
  for (const alterar of [m => delete m.corte_em, m => delete m.dia_final_completo,
    m => m.corte_em = '2026-06-30T17:23:00', m => m.corte_em = '2026-06-30T17:23:00-03:00',
    m => m.corte_em = '2026-07-01T01:00:00Z', m => m.dia_final_completo = 'true',
    m => { m.dia_final_completo = false; m.corte_em = '2026-07-01T12:00:00-03:00'; }]) {
    const p = lote(); alterar(p.meses[0]); rejeita(() => S.validarLote(p));
  }
  const p = lote(); p.meses[0].corte_em = '2026-07-01T03:00:00Z'; assert.equal(S.validarLote(p).meses[0].dia_final_completo, true);
  p.meses[0].dia_final_completo = false; p.meses[0].corte_em = '2026-06-30T17:23:00-03:00';
  assert.equal(S.validarLote(p).meses[0].dia_final_completo, false);
});
test('validação recusa chaves perigosas, datas impossíveis, ciclos e registros duplicados', () => {
  const p = lote(); p.registros[0].originais = JSON.parse('{"__proto__":{"x":1}}'); rejeita(() => S.validarLote(p));
  const c = lote(); c.extra = c; rejeita(() => S.validarLote(c));
  rejeita(() => S.periodo('2026-02-30', '2026-06-10'));
  rejeita(() => S.periodo('2026-06-10', '2026-06-09'));
  const d = lote(); d.meses.push(clone(d.meses[0])); rejeita(() => S.validarLote(d));
});
test('CLI exige fonte/autor, conserva UTF-8 base64 e não aplica por padrão', async () => {
  assert.equal(cli.argumentos(['--stdin-base64', '--autor', 'admin'])['--aplicar'], undefined);
  assert.equal(cli.argumentos(['--stdin-base64', '--autor', 'admin', '--aplicar'])['--aplicar'], true);
  for (const args of [[], ['--arquivo', 'x', '--stdin-base64', '--autor', 'a'], ['--stdin-base64'], ['--force']]) rejeita(() => cli.argumentos(args));
  const b = Buffer.from(JSON.stringify(lote()));
  assert.deepEqual(await cli.lerBase64(Readable.from([b.toString('base64')])), b);
  await assert.rejects(cli.lerBase64(Readable.from([b.toString('base64') + '\n'])), e => e.status === 400);
});

async function app(t, pool) {
  const a = express(); a.use('/hub/atos-lavrados', createRouter({ pool,
    session: async token => token === 'admin' ? { login: 'admin.fixture', admin: true } : token === 'equipe' ? { login: 'equipe' } : null,
    ehAdmin: u => u.admin === true }));
  const s = await new Promise(resolve => { const srv = a.listen(0, '127.0.0.1', () => resolve(srv)); });
  t.after(() => new Promise(resolve => { s.close(resolve); s.closeAllConnections(); }));
  return (rota, token = 'admin', body) => fetch(`http://127.0.0.1:${s.address().port}/hub/atos-lavrados${rota}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'X-Auth-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}
test('HTTP exige sessão/admin antes de acessar dados ou importar; malformed JSON é 400', async t => {
  let n = 0; const req = await app(t, { connect: async () => { n++; throw Error('não deveria conectar'); } });
  for (const token of ['', 'invalido', 'equipe']) {
    const r = await req('/meses', token); assert.equal(r.status, token === 'equipe' ? 403 : 401);
    assert.equal(r.headers.get('cache-control'), 'private, no-store'); assert.match(r.headers.get('content-type'), /application\/json/);
    assert.equal((await req('/lotes', token, '{')).status, token === 'equipe' ? 403 : 401);
  }
  assert.equal((await req('/lotes', 'admin', '{')).status, 400); assert.equal(n, 0);
});

test('PostgreSQL e HTTP: snapshots, cobertura, histórico, concorrência e vínculo por evidência', { skip: !process.env.ATOS_TEST_DATABASE_URL }, async t => {
  const admin = new Pool({ connectionString: process.env.ATOS_TEST_DATABASE_URL, max: 1 });
  const schema = 'atos_test_' + randomUUID().replace(/-/g, ''); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.ATOS_TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 4 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query('CREATE TABLE protocolos(numero INTEGER PRIMARY KEY); INSERT INTO protocolos(numero) VALUES(100); CREATE TABLE produtividade_mes(dados JSONB); INSERT INTO produtividade_mes VALUES(\'{"atos":5324,"total":10000}\')');
  const req = await app(t, pool), p = lote(); p.registros.push(ato(2));
  await t.test('meses vazios e fonte ausente são desconhecidos, não zero oficial', async () => {
    assert.deepEqual((await (await req('/meses')).json()).meses, []);
    const r = await S.resumo(pool, '2026-06-01', '2026-06-30'); assert.equal(r.total_oficial, null); assert.equal(r.total_observado, 0);
  });
  await t.test('dry-run calcula prévia sem inserir lote, versões ou atos', async () => {
    const r = await req('/lotes/validar', 'admin', p); assert.equal(r.status, 200); assert.equal((await r.json()).dry_run, true);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM atos_lavrados_lotes')).rows[0].n, 0);
    assert.equal((await S.meses(pool)).meses.length, 0);
  });
  await t.test('importação cria fonte oficial com responsável pela importação, sem ranking inferido', async () => {
    const r = await req('/lotes', 'admin', p); assert.equal(r.status, 200);
    assert.equal((await r.json()).meses[0].total, 2);
    const m = (await S.meses(pool)).meses[0]; assert.equal(m.total_oficial, 2); assert.equal(m.sem_vinculo, 2);
    const b = await S.backup(pool, p.operacao_id); assert.deepEqual(b.conteudo, p); assert.equal(b.criado_por, 'admin.fixture');
  });
  await t.test('repetição do mesmo lote é idempotente; mesmo id com conteúdo diferente é 409', async () => {
    const r = await req('/lotes', 'admin', p); assert.equal(r.status, 200); assert.equal((await r.json()).repetido, true);
    const outro = clone(p); outro.registros[0].originais.novo = 'diferente'; assert.equal((await req('/lotes', 'admin', outro)).status, 409);
    assert.equal((await S.versoes(pool, '2026-06')).length, 1);
  });
  await t.test('dois atos no mesmo protocolo não se fundem; vínculo exige evidência e não altera pesos/financeiro', async () => {
    const chaves = S.validarLote(p).registros.map(r => r.chave);
    const semEvid = await req('/vinculos', 'admin', { chave: chaves[0], protocolo_hub: 100, revisao_base: 0 }); assert.equal(semEvid.status, 400);
    for (const chave of chaves) assert.equal((await req('/vinculos', 'admin', { chave, protocolo_hub: 100, revisao_base: 0, evidencia: { tipo: 'referencia_documental', referencia: 'Documento de teste, item 1' } })).status, 200);
    const r = await S.resumo(pool, '2026-06-01', '2026-06-30'); assert.equal(r.total_oficial, 2); assert.equal(r.com_vinculo, 2); assert.equal(r.sem_vinculo, 0);
    assert.equal(r.responsaveis, undefined);
    assert.deepEqual((await pool.query('SELECT dados FROM produtividade_mes')).rows[0].dados, { atos: 5324, total: 10000 });
  });
  await t.test('edição cria snapshot sem destruir original e concorrência não sobrescreve', async () => {
    const a = lote(); a.meses[0].revisao_base = 1; a.registros.push(ato(3));
    const b = clone(a); b.operacao_id = randomUUID();
    const rs = await Promise.all([req('/lotes', 'admin', a), req('/lotes', 'admin', b)]);
    assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
    assert.equal((await S.versoes(pool, '2026-06')).length, 2);
    assert.deepEqual((await S.backup(pool, p.operacao_id)).conteudo, p);
    assert.equal((await S.meses(pool)).meses[0].revisao, 2);
  });
  await t.test('identidade em outro mês exige conciliar ambos, mesmo alterando protocolo e data', async () => {
    const x = lote(); x.meses = [cobertura('2026-07', '2026-07-31')]; x.registros = [ato(1, '2026-07-05')]; x.registros[0].protocolo = 'CORRIGIDO';
    assert.equal((await req('/lotes', 'admin', x)).status, 409);
    x.meses.push(cobertura('2026-06', '2026-06-30', 2));
    assert.equal((await req('/lotes', 'admin', x)).status, 200);
    assert.equal((await S.resumo(pool, '2026-06-01', '2026-06-30')).total_oficial, 0);
    assert.equal((await S.resumo(pool, '2026-07-01', '2026-07-31')).total_oficial, 1);
  });
  await t.test('mês parcial não vira zero/total fechado; semana dentro da cobertura tem total exato', async () => {
    const x = lote(); x.meses = [cobertura('2026-10', '2026-10-09', 0, false, '2026-10-09T17:23:00-03:00')]; x.registros = [ato(50, '2026-10-05')];
    assert.equal((await req('/lotes', 'admin', x)).status, 200);
    const mes = await S.resumo(pool, '2026-10-01', '2026-10-31'); assert.equal(mes.total_oficial, null); assert.equal(mes.total_observado, 1);
    const semana = await S.resumo(pool, '2026-10-01', '2026-10-07'); assert.equal(semana.total_oficial, 1); assert.equal(semana.cobertura_completa, true);
    for (const inicio of ['2026-10-01', '2026-10-09']) { const parcial = await S.resumo(pool, inicio, '2026-10-09'); assert.equal(parcial.total_oficial, null); assert.equal(parcial.cobertura_completa, false); }
    assert.equal((await S.resumo(pool, '2026-10-01', '2026-10-08')).total_oficial, 1);
    const versao = (await S.versoes(pool, '2026-10'))[0]; assert.equal(versao.dia_final_completo, false); assert.equal(versao.corte_em.toISOString(), '2026-10-09T20:23:00.000Z');
    x.operacao_id = randomUUID(); x.meses[0] = cobertura('2026-10', '2026-10-09', 1);
    assert.equal((await req('/lotes', 'admin', x)).status, 200);
    assert.equal((await S.resumo(pool, '2026-10-01', '2026-10-09')).total_oficial, 1);
    assert.notEqual((await S.versoes(pool, '2026-10'))[0].sha256, versao.sha256);
    assert.equal((await S.resumo(pool, '2026-07-01', '2026-07-31')).total_oficial, 1);
    const anual = await S.resumo(pool, '2026-01-01', '2026-12-31'); assert.equal(anual.total_oficial, null);
  });
  await t.test('registrado com protocolo ausente é contado, alertado e nunca vinculado por inferência', async () => {
    const x = lote(); x.meses = [cobertura('2026-08', '2026-08-31')];
    x.registros = [ato(2035, '2026-08-05')]; x.registros[0].protocolo = ''; x.registros[0].originais.Protocolo = '';
    x.registros[0].pendencia_identificacao = ['protocolo_ausente_na_fonte'];
    assert.equal((await req('/lotes', 'admin', x)).status, 200);
    const r = await S.resumo(pool, '2026-08-01', '2026-08-31');
    assert.equal(r.total_oficial, 1); assert.equal(r.sem_vinculo, 1); assert.equal(r.com_pendencia_identificacao, 1);
    const ls = await S.atos(pool, '2026-08-01', '2026-08-31'); assert.equal(ls.itens[0].protocolo_hub, null); assert.equal(ls.itens[0].registro.protocolo, '');
    const originalId = x.operacao_id; x.operacao_id = randomUUID(); x.meses[0].revisao_base = 1;
    x.registros[0].protocolo = 'NOVA-REFERENCIA'; x.registros[0].originais.Protocolo = 'NOVA-REFERENCIA'; delete x.registros[0].pendencia_identificacao;
    assert.equal((await req('/lotes', 'admin', x)).status, 200);
    const corrigido = await S.resumo(pool, '2026-08-01', '2026-08-31'); assert.equal(corrigido.total_oficial, 1); assert.equal(corrigido.com_pendencia_identificacao, 0);
    assert.equal((await S.backup(pool, originalId)).conteudo.registros[0].protocolo, '');
    assert.notEqual((await S.atos(pool, '2026-08-01', '2026-08-31')).itens[0].chave, ls.itens[0].chave);
  });
  await t.test('corte parcial no último dia do mês não fecha competência inteira', async () => {
    const x = lote(); x.meses = [cobertura('2026-11', '2026-11-30', 0, false, '2026-11-30T17:23:00-03:00')]; x.registros = [ato(300, '2026-11-01')];
    await S.importar(pool, x, 'admin.fixture');
    const m = (await S.meses(pool)).meses.find(m => m.mes === '2026-11'); assert.equal(m.total_oficial, null); assert.equal(m.cobertura_completa, false);
    assert.equal((await S.resumo(pool, '2026-11-01', '2026-11-29')).total_oficial, 1);
    assert.equal((await S.resumo(pool, '2026-11-01', '2026-11-30')).total_oficial, null);
  });
  await t.test('CLI real recebe stdin, prévia não grava; aplicar é idempotente e retorna versões anteriores', async () => {
    const x = lote(); x.meses = [cobertura('2026-09', '2026-09-30')]; x.registros = [ato(90, '2026-09-10')];
    const url = new URL(process.env.ATOS_TEST_DATABASE_URL); url.searchParams.set('options', '-c search_path=' + schema);
    const chamar = aplicar => {
      const stdout = execFileSync(process.execPath, [path.join(__dirname, '../scripts/importar-atos-lavrados.js'), '--stdin-base64', '--autor', 'operador.cli', ...(aplicar ? ['--aplicar'] : [])],
        { env: { ...process.env, DATABASE_URL: url.toString() }, input: Buffer.from(JSON.stringify(x)).toString('base64'), encoding: 'utf8' });
      assert.doesNotMatch(stdout, /OPERADOR FICTÍCIO|postgresql:|originais/); return JSON.parse(stdout);
    };
    assert.equal(chamar(false).dry_run, true); assert.equal((await S.resumo(pool, '2026-09-01', '2026-09-30')).total_oficial, null);
    assert.equal(chamar(true).repetido, false); assert.equal(chamar(true).repetido, true);
    assert.equal((await S.backup(pool, x.operacao_id)).criado_por, 'operador.cli');
    x.operacao_id = randomUUID(); x.meses[0].revisao_base = 1;
    const recibo = chamar(true); assert.equal(recibo.versoes_anteriores[0].revisao, 1); assert.equal(recibo.meses[0].revisao, 2);
    assert.equal((await S.resumo(pool, '2026-09-01', '2026-09-30')).total_oficial, 1);
  });
});
