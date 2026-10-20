'use strict';
// Todos os registros e colaboradores são sintéticos.
const test = require('node:test'), assert = require('node:assert/strict');
const S = require('../prazos-semanal');
const CORTE = '2026-10-20T15:00:00Z';
const fila = (n, extra = {}) => ({ card_id: String(n), protocolo: n, inicio: '2026-10-01T11:00:00Z',
  vencimento: '2026-10-21T20:00:00Z', regra: { ato: 'CV-Urbano', dias: 10, uteis: true },
  estado: 'ativo', responsavel_login: 'writer.a', responsavel_nome: 'Pessoa A',
  confirmado_em: '2026-10-20T14:55:00Z', card_url: 'https://trello.com/c/SYNTHETIC', ...extra });
const conclusao = (n, extra = {}) => ({ ...fila(n), tipo: 'ato', ato: 'CV-Urbano',
  concluido_em: '2026-10-21T19:00:00Z', no_prazo: true, atraso_horas_uteis: 0, horas_uteis: 8,
  evidencia: 'evento-ficticio-' + n, ...extra });
const montar = (f = [], c = [], query = {}, corte = CORTE, integral = false) =>
  S.montar({ fila: f, conclusoes: c, corte }, S.pedido({ ref: '2026-10-20', ...query }), integral);

test('semana civil local, virada de mês e validação estrita de query', () => {
  assert.deepEqual([S.pedido({ ref: '2026-11-01' }).inicio, S.pedido({ ref: '2026-11-01' }).fim], ['2026-10-26', '2026-11-01']);
  for (const q of [{ ref: '2026-02-30' }, { ref: ['2026-10-20'] }, { ref: '2026-1-1' }, { ref: '1999-12-31' },
    { pagina_fila: '0' }, { pagina_fila: '1.2' }, { pagina_conclusoes: '-1' }, { limite: '101' },
    { responsavel: 'writer a' }, { responsavel: {} }, { situacao: 'desconhecida' }, { tipo: ['INV'] }])
    assert.throws(() => S.pedido(q), e => e.status === 400);
});
test('fila atual inclui acumulados anteriores, mantém limite exato e não usa due nem reinicia início', () => {
  const old = fila(1, { vencimento: '2026-10-02T20:00:00Z', due: '2099-01-01T00:00:00Z' });
  const rows = [old, fila(2, { vencimento: CORTE }), fila(3, { vencimento: '2026-10-26T02:59:59Z' }),
    fila(4, { vencimento: '2026-10-26T03:00:00Z' }), fila(5, { estado: 'concluido' }), fila(6, { estado: 'arquivado' }),
    fila(7, { estado: 'inacessivel', vencimento: '2026-10-16T20:00:00Z' })];
  const before = JSON.stringify(rows), r = montar(rows);
  assert.deepEqual(r.fila.itens.map(i => i.card_id), ['1', '7', '2', '3']);
  assert.equal(r.resumo.vencidos, 2); assert.equal(r.resumo.a_vencer, 2);
  assert.equal(r.fila.itens[0].inicio, new Date(old.inicio).toISOString());
  assert.equal(r.fila.itens[0].vencimento, new Date(old.vencimento).toISOString());
  assert.ok(r.fila.itens[1].pendencias.includes('cartao_inacessivel'));
  assert.equal(r.fila.itens[2].situacao, 'a_vencer');
  assert.equal(JSON.stringify(rows), before);
});
test('semana anterior não reconstrói fila: conserva atraso atual e separa conclusão antiga', () => {
  const r = montar([fila(1, { vencimento: '2026-10-19T20:00:00Z' })], [
    conclusao(2, { vencimento: '2026-10-16T20:00:00Z', concluido_em: '2026-10-16T19:00:00Z' })
  ], { ref: '2026-10-13' });
  assert.equal(r.fila.total, 1); assert.equal(r.conclusoes.total, 1);
  assert.equal(r.cobertura.reconstrucao_historica, false);
  assert.match(r.criterios.conclusoes, /Não equivale.*Extra Digital/);
});
test('conclusões usam semana local, corte real, primeira evidência e nunca métricas setoriais', () => {
  const rows = [
    conclusao(1, { concluido_em: '2026-10-19T02:59:59Z' }),
    conclusao(2, { concluido_em: '2026-10-19T03:00:00Z' }),
    conclusao(3, { concluido_em: CORTE }),
    conclusao(4, { concluido_em: '2026-10-20T15:00:01Z' }),
    conclusao(5, { concluido_em: '2026-10-19T12:00:00Z', tipo: 'setor' })];
  const r = montar([], rows); assert.deepEqual(r.conclusoes.itens.map(i => i.card_id), ['2', '3']);
  assert.equal(r.resumo.concluidos_no_prazo, 2);
  assert.throws(() => montar([], [conclusao(6, { concluido_em: CORTE, evidencia: '' })]), e => e.codigo === 'FONTE_INCONSISTENTE');
  assert.throws(() => montar([], [conclusao(6, { concluido_em: CORTE, horas_uteis: 'invalido' })]), e => e.codigo === 'FONTE_INCONSISTENTE');
  assert.throws(() => montar([], [rows[1], rows[1]]), e => e.codigo === 'FONTE_INCONSISTENTE');
});
test('atraso corrido e útil são distintos, sem prometer pontualidade durante fim de semana', () => {
  const r = montar([fila(1, { vencimento: '2026-10-16T20:00:00Z' })], [], {}, '2026-10-19T12:00:00Z');
  assert.equal(r.fila.itens[0].atraso_horas_uteis, 1);
  assert.equal(r.fila.itens[0].atraso_horas_corridas, 64);
  assert.equal(r.fila.itens[0].situacao, 'vencido');
});
test('filtros exatos, sem responsável, tipos e resumos independentes da paginação/situação', () => {
  const rows = [fila(1, { vencimento: '2026-10-19T20:00:00Z' }), fila(2),
    fila(3, { responsavel_login: null }), fila(4, { responsavel_login: 'writer.ab', responsavel_nome: 'Outra pessoa' }),
    fila(5, { regra: { ato: 'INV', dias: 4, uteis: true } })];
  let r = montar(rows, [], { responsavel: 'writer.a', tipo: 'CV-Urbano', situacao: 'vencidos', limite: '1' });
  assert.equal(r.resumo.vencidos, 1); assert.equal(r.resumo.a_vencer, 1); assert.equal(r.fila.total, 1);
  assert.equal(r.por_responsavel.length, 1); assert.equal(r.por_responsavel[0].login, 'writer.a');
  r = montar(rows, [], { responsavel: 'sem_responsavel' });
  assert.equal(r.fila.total, 1); assert.equal(r.fila.itens[0].responsavel_nome, 'Sem responsável');
  assert.equal(r.resumo.sem_responsavel, 1);
  assert.equal(montar(rows, [], { responsavel: 'WRITER.A' }).fila.total, 0);
});
test('paginação estável separa fila e conclusões; CSV integral ignora página e preserva filtros', () => {
  const f = [fila(3), fila(1), fila(2)];
  const c = [conclusao(6, { concluido_em: CORTE }), conclusao(5, { concluido_em: CORTE })];
  const r = montar(f, c, { limite: '1', pagina_fila: '2', pagina_conclusoes: '1' });
  assert.equal(r.fila.total, 3); assert.equal(r.fila.paginas, 3); assert.equal(r.fila.itens[0].card_id, '2');
  assert.equal(r.conclusoes.itens[0].card_id, '5'); assert.equal(r.resumo.concluidos, 2);
  const all = montar(f, c, { limite: '1', pagina_fila: '2' }, CORTE, true);
  assert.equal(all.fila.itens.length, 3); assert.equal(all.conclusoes.itens.length, 2);
  assert.equal(montar(f, c, { pagina_fila: '99' }).fila.itens.length, 0);
  all.fila.itens[0].responsavel_nome = ' =SOMA(A1)';
  assert.match(S.csv(all), /' =SOMA/); assert.match(S.csv(all), /Atraso em horas úteis/);
});
test('confirmações antigas/ausentes e erro são visíveis; datas ruins falham sem zeros', () => {
  const r = montar([fila(1, { confirmado_em: '2026-10-20T14:29:59Z' }), fila(2, { confirmado_em: null }),
    fila(3, { erro: 'algo_privado_que_nao_deve_sair' }), fila(4, { confirmado_em: '2026-10-20T14:30:00Z' })]);
  assert.equal(r.cobertura.pendencias_sincronizacao, 3);
  assert.ok(r.fila.itens[0].pendencias.includes('confirmacao_desatualizada'));
  assert.doesNotMatch(JSON.stringify(r), /algo_privado/);
  assert.throws(() => montar([fila(1, { vencimento: 'invalido' })]), e => e.status === 503);
  assert.equal(montar().cobertura.estado, 'sem_registros_observados');
  assert.ok(montar([fila(5, { confirmado_em: '2026-10-20T15:01:00Z' })]).fila.itens[0].pendencias.includes('confirmacao_temporal_invalida'));
});
function poolSintetico({ ausente = false } = {}) {
  const queries = [], args = [], state = { liberado: false };
  const client = { release() { state.liberado = true; }, async query(sql, params) {
    queries.push(sql); args.push(params);
    if (/transaction_timestamp/.test(sql)) return { rows: [{ corte: new Date(CORTE) }] };
    if (/FROM prazos_atos a/.test(sql)) {
      if (ausente) throw Object.assign(Error('privado'), { code: '42P01' });
      return { rows: [fila(1)] };
    }
    return { rows: [] };
  } };
  return { pool: { connect: async () => client }, queries, args, state };
}
test('consulta usa única transação repeatable read read only; nenhuma migração, escrita ou Trello', async () => {
  const f = poolSintetico(), r = await S.consultar(f.pool, { ref: '2026-10-20' });
  assert.equal(r.fila.total, 1); assert.equal(r.corte_em, new Date(CORTE).toISOString());
  assert.equal(f.queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(f.queries.at(-1), 'COMMIT'); assert.ok(f.state.liberado);
  assert.ok(f.queries.every(q => !/\b(INSERT|UPDATE|DELETE|ALTER|CREATE)\b/.test(q)));
  const index = f.queries.findIndex(q => /FROM prazos_metricas/.test(q));
  assert.equal(f.args[index][0].toISOString(), '2026-10-19T03:00:00.000Z');
  assert.equal(f.args[index][1].toISOString(), '2026-10-26T03:00:00.000Z');
  const bad = poolSintetico({ ausente: true });
  await assert.rejects(S.consultar(bad.pool, { ref: '2026-10-20' }), e => e.status === 503 && e.codigo === 'FONTE_AUSENTE');
  assert.equal(bad.queries.at(-1), 'ROLLBACK'); assert.ok(bad.state.liberado);
});
test('SQL real agrega fontes distintas e mantém os registros intactos', async t => {
  const { PGlite } = require('@electric-sql/pglite'), db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE usuarios(login text PRIMARY KEY,nome text);
    ${require('../prazos-atos').SCHEMA}
    ${require('../prazos-metricas').SCHEMA}`);
  await db.query("INSERT INTO usuarios VALUES('writer.a','Pessoa sintética')");
  await db.query(`INSERT INTO prazos_atos(card_id,protocolo,inicio,evidencia,vencimento,regra,estado,responsavel_login,confirmado_em)
    VALUES('ficticio',1,'2026-10-01T11:00:00Z','inicio-ficticio','2026-10-02T20:00:00Z',
      '{"ato":"CV-Urbano","dias":1,"uteis":true}','ativo','writer.a',now())`);
  await db.query(`INSERT INTO prazos_metricas(chave,tipo,card_id,protocolo,responsavel_login,ato,inicio,vencimento,concluido_em,no_prazo,horas_uteis,atraso_horas_uteis,evidencia)
    VALUES('ato:entrega','ato','entrega',2,'writer.a','INV','2026-10-01T11:00:00Z','2026-10-02T20:00:00Z','2026-10-02T19:00:00Z',true,15,0,'fim-ficticio')`);
  const before = JSON.stringify((await db.query('SELECT * FROM prazos_atos')).rows);
  const metricas = JSON.stringify((await db.query('SELECT * FROM prazos_metricas')).rows);
  const queries = [], client = { release() {}, async query(sql, params) { queries.push(sql); return db.query(sql, params); } };
  const result = await S.consultar({ connect: async () => client }, { ref: '2026-10-02' });
  assert.equal(result.fila.total, 1); assert.equal(result.conclusoes.total, 1);
  assert.equal(result.conclusoes.itens[0].responsavel_nome, 'Pessoa sintética');
  assert.equal(result.conclusoes.itens[0].trello_url, null);
  assert.ok(queries.every(q => !/\b(INSERT|UPDATE|DELETE|ALTER|CREATE)\b/.test(q)));
  assert.equal(JSON.stringify((await db.query('SELECT * FROM prazos_atos')).rows), before);
  assert.equal(JSON.stringify((await db.query('SELECT * FROM prazos_metricas')).rows), metricas);
});
test('rotas JSON/CSV exigem administrador e não consultam fontes sem autorização', async t => {
  const db = require('../db'), express = require('express'), R = require('../relatorios');
  const oldConnect = db.pool.connect, oldSessao = db.sessaoValida, oldAdmins = process.env.RELATORIOS_ADMINS;
  const f = poolSintetico(); db.pool.connect = f.pool.connect;
  process.env.RELATORIOS_ADMINS = 'test.admin'; db.sessaoValida = async token => token ? { login: token } : null;
  const app = express(); app.use('/hub/relatorios', R.router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    db.pool.connect = oldConnect; db.sessaoValida = oldSessao;
    if (oldAdmins === undefined) delete process.env.RELATORIOS_ADMINS; else process.env.RELATORIOS_ADMINS = oldAdmins;
  });
  const get = (suffix = '', token = 'test.admin') => fetch(`http://127.0.0.1:${server.address().port}/hub/relatorios/prazos/semanal${suffix}?ref=2026-10-20`,
    { headers: token ? { 'X-Auth-Token': token } : {} });
  for (const suffix of ['', '.csv']) {
    assert.equal((await get(suffix, '')).status, 401);
    assert.equal((await get(suffix, 'test.writer')).status, 403);
  }
  assert.equal(f.queries.length, 0);
  const json = await get(); assert.equal(json.status, 200); assert.match(json.headers.get('cache-control'), /no-store/);
  assert.equal((await json.json()).fila.total, 1);
  const exported = await get('.csv'); assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /text\/csv/);
  assert.match(await exported.text(), /Conclusão operacional/);
  const jsonCsv = await fetch(`http://127.0.0.1:${server.address().port}/hub/relatorios/prazos/semanal.csv?ref=2026-10-20&formato=json`,
    { headers: { 'X-Auth-Token': 'test.admin' } });
  assert.equal(jsonCsv.status, 200);
  const download = await jsonCsv.json();
  assert.match(download.csv, /Conclusão operacional/);
  assert.equal(download.nome_arquivo, 'prazos-2026-10-19-2026-10-25.csv');
  db.pool.connect = poolSintetico({ ausente: true }).pool.connect;
  const missing = await get(); assert.equal(missing.status, 503);
  assert.equal((await missing.json()).codigo, 'FONTE_AUSENTE');
});
