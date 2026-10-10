'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../receita-relatorios');
const R = require('../receita-liquida');
const row = (mes, total = 1000) => ({ ano: 2026, mes, dados: { total, atos: 100, diasUteis: 20 }, fonte: 'Pesquisa sintética de todos os atos', importado_em: '2026-10-09T20:00:00Z' });

test('competências mensais da semana ficam separadas, sem receita semanal inferida ou filtro de escrituras', async () => {
  const rows = [row(9, 1000), row(10, 2000)], original = JSON.stringify(rows), queries = [];
  const r = await M.consultar({ query: async (sql, params) => { queries.push({ sql, params }); return { rows }; } }, '2026-09-28', '2026-10-04');
  assert.deepEqual(r.competencias.map(x => x.mes), ['2026-09', '2026-10']);
  assert.deepEqual(r.competencias.map(x => x.receita_liquida), [704.31, 1408.61]);
  assert.deepEqual(r.competencias.map(x => x.media_dia_util), [35.22, 70.43]);
  assert.deepEqual(r.competencias.map(x => x.lancamentos), [100, 100]);
  assert.equal(r.escopo, 'competencias_mensais'); assert.equal(r.base_individual, 'usuario_financeiro');
  assert.equal(r.total, undefined); assert.equal(r.receita_semanal, undefined);
  assert.equal(r.receita_por_autor.total_atribuido, null); assert.deepEqual(r.receita_por_autor.colaboradores, []);
  assert.deepEqual(queries[0].params, [['2026-09', '2026-10']]);
  assert.doesNotMatch(queries[0].sql, /atos_lavrados|conclusoes|escreventes/);
  assert.equal(JSON.stringify(rows), original);
});

test('fonte ausente/indisponível não vira zero; bruto zero explícito é zero e líquido não sofre nova dedução', async () => {
  const ausente = await M.consultar({ query: async () => ({ rows: [row(9, 0)] }) }, '2026-09-28', '2026-10-04');
  assert.equal(ausente.competencias[0].status, 'disponivel'); assert.equal(ausente.competencias[0].receita_liquida, 0);
  assert.equal(ausente.competencias[1].status, 'ausente'); assert.equal(ausente.competencias[1].receita_liquida, null);
  const indisponivel = await M.consultar({ query: async () => { throw new Error('indisponível'); } }, '2026-09-28', '2026-10-04');
  assert.ok(indisponivel.competencias.every(x => x.status === 'indisponivel' && x.receita_liquida === null));
  const liquido = row(10, 704.31); liquido.dados.base_receita = 'liquida_apos_repasses';
  assert.equal(M.projetarMes('2026-10', liquido).status, 'indisponivel');
  const negativo = M.projetarMes('2026-10', row(10, -1000)); assert.equal(negativo.receita_liquida, -704.31); assert.equal(negativo.media_dia_util, -35.22);
  assert.deepEqual(R.financeiro(1000).receita_por_autor, { status: 'pendente_vinculo_financeiro_por_ato', colaboradores: [], total_atribuido: null });
});

test('período mensal, virada do ano, datas impossíveis e ordem inválida', () => {
  assert.deepEqual(M.competencias('2026-10-01', '2026-10-31'), ['2026-10']);
  assert.deepEqual(M.competencias('2026-12-28', '2027-01-03'), ['2026-12', '2027-01']);
  for (const [a, b] of [['2026-02-30', '2026-03-05'], ['2026-10-10', '2026-10-01'], ['2024-01-01', '2026-10-01']]) assert.throws(() => M.competencias(a, b), /período financeiro inválido/);
});

test('gerar relatório incorpora receita canônica antes dos cartões no HTML/texto e no CSV, sem enviar', async () => {
  const db = require('../db'), atos = require('../atos-lavrados-db'), email = require('../relatorio-email'), relatorios = require('../relatorios');
  const oldQuery = db.pool.query, oldResumo = atos.resumo, oldEnviar = email.enviar;
  let envios = 0; const queries = [];
  try {
    db.pool.query = async (sql, params) => {
      queries.push(sql);
      if (/FROM produtividade_mes/.test(sql)) { assert.deepEqual(params, [['2026-09']]); return { rows: [row(9)] }; }
      if (/FROM escreventes/.test(sql)) return { rows: [{ login: 'mesmo.login', nome: 'Pessoa Fictícia' }] };
      return { rows: [] };
    };
    atos.resumo = async () => ({ total_oficial: 1, total_observado: 1, cobertura_completa: true, sem_vinculo: 1 });
    email.enviar = async () => { envios++; throw new Error('não deve enviar'); };
    const g = await relatorios.gerar('mensal', '2026-10-10', { wip: false });
    assert.equal(g.rel.receita_mensal.competencias[0].receita_liquida, 704.31);
    assert.equal(g.rel.equipe.concluidos, 0); assert.equal(g.rel.atos_lavrados.total_oficial, 1);
    assert.equal(g.rel.escreventes[0].receita_liquida, undefined);
    assert.equal(g.rel.receita_mensal.receita_por_autor.total_atribuido, null);
    for (const texto of [g.html, g.texto]) {
      assert.match(texto, /Receita líquida do cartório/); assert.match(texto, /R\$ 704,31/); assert.match(texto, /09\/2026/);
      assert.doesNotMatch(texto, /R\$ 1\.000,00|R\$ 295,69|R\$ 496,08/);
      // Não usa o preheader oculto como posição de cartão.
      assert.ok(texto.indexOf('Receita líquida do cartório') < texto.indexOf('Equipe'));
    }
    assert.match(g.csv, /2026-09;704,31;100;35,22;disponivel/);
    assert.match(g.csv, /Receita por autor pendente/);
    assert.equal(envios, 0); assert.ok(queries.every(sql => !/INSERT|UPDATE|DELETE|ALTER|CREATE/.test(sql)));
  } finally { db.pool.query = oldQuery; atos.resumo = oldResumo; email.enviar = oldEnviar; }
});

test('endpoint leve exige sessão/admin, consulta somente financeiro e preserva a semântica de referência', async t => {
  const db = require('../db'), relatorios = require('../relatorios'), express = require('express');
  const oldQuery = db.pool.query, oldSessao = db.sessaoValida, oldAdmins = process.env.RELATORIOS_ADMINS;
  const consultas = []; let falhar = false;
  process.env.RELATORIOS_ADMINS = 'cesar.bravo';
  db.sessaoValida = async token => token ? { login: token } : null;
  db.pool.query = async (sql, params) => {
    consultas.push(params[0]); assert.match(sql, /FROM produtividade_mes/);
    if (falhar) throw new Error('falha sintética');
    return { rows: params[0].map(m => row(Number(m.slice(5)))) };
  };
  const app = express(); app.use('/hub/relatorios', relatorios.router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    db.pool.query = oldQuery; db.sessaoValida = oldSessao;
    if (oldAdmins === undefined) delete process.env.RELATORIOS_ADMINS; else process.env.RELATORIOS_ADMINS = oldAdmins;
  });
  const get = (qs, login = 'cesar.bravo') => fetch(`http://127.0.0.1:${server.address().port}/hub/relatorios/receita-mensal?${qs}`, { headers: login ? { 'X-Auth-Token': login } : {} });
  assert.equal((await get('tipo=mensal&ref=2026-10-01', '')).status, 401);
  assert.equal((await get('tipo=mensal&ref=2026-10-01', 'outro.usuario')).status, 403);
  assert.equal(consultas.length, 0);
  const resposta = await get('tipo=mensal&ref=2026-10-01'); assert.equal(resposta.status, 200);
  assert.equal(resposta.headers.get('cache-control'), 'private, no-store'); assert.equal(resposta.headers.get('x-content-type-options'), 'nosniff');
  const mensal = (await resposta.json()).receita_mensal;
  assert.deepEqual(mensal.periodo_relatorio, { inicio: '2026-09-01', fim: '2026-09-30' });
  assert.deepEqual(mensal.competencias.map(x => x.mes), ['2026-09']);
  const semanal = (await (await get('tipo=semanal&ref=2026-10-05')).json()).receita_mensal;
  assert.deepEqual(semanal.periodo_relatorio, { inicio: '2026-09-28', fim: '2026-10-04' });
  assert.deepEqual(semanal.competencias.map(x => x.mes), ['2026-09', '2026-10']);
  assert.equal((await get('tipo=mensal&ref=2026-02-30')).status, 400);
  assert.equal((await get('tipo=diario&ref=2026-10-01')).status, 400);
  falhar = true;
  const ausente = await get('tipo=mensal&ref=2026-10-01'); assert.equal(ausente.status, 200);
  assert.equal((await ausente.json()).receita_mensal.competencias[0].status, 'indisponivel');
});
