'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const S = require('../atos-lavrados-db');
const G = require('../atos-lavrados-criado-por');
const clone = x => JSON.parse(JSON.stringify(x));
const fonte = { lote_id: '11111111-1111-4111-8111-111111111111', fonte: { sistema: 'Extra Digital', arquivo: 'fixture.csv', sha256: 'd'.repeat(64) } };
const identidade = n => ({ documento: 'Notas', minuta: String(n), protocolo: 'P' + n, livro: '1', folha: String(n) });
const registro = (n, criador = 'pessoa.1') => ({ ...identidade(n), data_lavratura: '2026-09-05', status: 4, status_nome: 'Registrado(a)', originais: { 'U. criador': criador, 'U. Alterou': 'pessoa.2', Finalidade: 'Compra e venda', 'Sub-tipo': 'Escritura com Valor' } });
const cadastro = [
  { login: 'pessoa.1', nome: 'Pessoa Um', cargo: 'Escrevente', escrevente: true, ativo: false },
  { login: 'pessoa.2', nome: 'Pessoa Dois', cargo: 'Escrevente', escrevente: true },
  { login: 'cesar.bravo', nome: 'César Bravo', cargo: 'Tabelião', escrevente: false },
  { login: 'recepcao', nome: 'Recepção', cargo: 'Atendente', escrevente: false }
];
function pedido(n = 1, chave = 'a'.repeat(64), revisao_base = 0, valor = 'pessoa.1') {
  return { chave, revisao_base, evidencia: { tipo: G.TIPO, marco: 'atribuicao_gerencial', ato: identidade(n), campo_ou_evento: 'U. criador', valor_original: valor,
    fonte: { sistema: 'Extra Digital', lote_id: fonte.lote_id, sha256: fonte.fonte.sha256, referencia: 'fixture.csv / Minuta ' + n, coletado_em: '2026-10-09T20:23:25.387Z' } } };
}
const prever = (p = pedido(), r = registro(1), c = cadastro, f = fonte) => S.preverAutoriaCriadoPor(p, r, c, f);
const expectativa = d => ({ sha256_calculado: d.evidencia.sha256_calculado, colaborador_id: d.colaborador.id, metodo: G.METODO });
const codigo = nome => e => e.codigo === nome;

test('Criado Por preserva valor literal, normaliza apenas identidade e não altera originais', () => {
  const p = pedido(1, 'a'.repeat(64), 0, ' PESSOA.1 '), r = registro(1, ' PESSOA.1 '), snapshot = clone({ p, r, cadastro, fonte });
  const d = prever(p, r);
  assert.deepEqual(d.colaborador, { id: 'pessoa.1', nome: 'Pessoa Um' });
  assert.equal(d.evidencia.valor_original, ' PESSOA.1 '); assert.equal(d.evidencia.decisao.colaborador.papel, 'escrevente');
  assert.equal(d.marco, 'atribuicao_gerencial'); assert.equal(d.evidencia.metodo, 'criado_por_extra');
  assert.equal(d.evidencia.fonte.coletado_em, '2026-10-09T20:23:25.387Z');
  assert.deepEqual({ p, r, cadastro, fonte }, snapshot);
  assert.equal(prever(p, r).evidencia.sha256_calculado, d.evidencia.sha256_calculado);
  assert.match(d.evidencia.sha256_calculado, /^[a-f0-9]{64}$/);
});

test('Tabelião identificado no cadastro é autor gerencial sem criar linha de escrevente', () => {
  const d = prever(pedido(1, 'a'.repeat(64), 0, 'cesar.bravo'), registro(1, 'cesar.bravo'));
  assert.deepEqual(d.evidencia.decisao.colaborador, { id: 'cesar.bravo', nome: 'César Bravo', papel: 'tabeliao' });
  for (const label of ['Criado Por', 'U.criador']) {
    const p = pedido(), r = registro(1); p.evidencia.campo_ou_evento = label; delete r.originais['U. criador']; r.originais[label] = 'pessoa.1';
    assert.equal(prever(p, r).evidencia.campo_ou_evento, label);
  }
});

test('campos literais, identidade completa e fonte ativa são conferidos, nunca inferidos', () => {
  for (const field of Object.keys(identidade(1))) { const p = pedido(); p.evidencia.ato[field] = 'diferente'; assert.throws(() => prever(p), codigo('IDENTIDADE_DIVERGENTE')); }
  const diferente = pedido(); diferente.evidencia.valor_original = 'PESSOA.1'; assert.throws(() => prever(diferente), codigo('CRIADOR_DIVERGENTE_DA_FONTE'));
  const rotulo = pedido(); rotulo.evidencia.campo_ou_evento = 'Criado Por'; assert.throws(() => prever(rotulo), codigo('CRIADOR_DIVERGENTE_DA_FONTE'));
  for (const f of [null, { ...fonte, lote_id: randomUUID() }, { ...fonte, fonte: { ...fonte.fonte, sha256: 'c'.repeat(64) } }, { ...fonte, fonte: { sistema: 'Extra Digital' } }]) assert.throws(() => prever(pedido(), registro(1), cadastro, f), codigo('FONTE_IMPORTADA_DIVERGENTE'));
  const r = registro(1); r.originais['Criado Por'] = 'pessoa.2';
  assert.throws(() => prever(pedido(), r), e => e.codigo === 'PENDENTE_SEM_ATRIBUICAO' && e.pendencias.includes('CRIADORES_ORIGINAIS_DIVERGENTES'));
});

test('desconhecido, homônimo, conta sem papel ou ausência de fonte nunca escolhem autor', () => {
  for (const [login, c] of [['ausente', cadastro], ['Pessoa Um', cadastro], ['recepcao', cadastro], ['pessoa.1', cadastro.concat(cadastro[0])]]) {
    assert.throws(() => prever(pedido(1, 'a'.repeat(64), 0, login), registro(1, login), c), e => e.status === 422 && e.codigo === 'PENDENTE_SEM_ATRIBUICAO' && e.pendencias.length === 1);
  }
  for (const alterar of [p => p.colaborador = { id: 'pessoa.2', nome: 'Pessoa Dois' }, p => p.evidencia.metodo = 'criado_por_extra', p => p.evidencia.decisao = {}, p => p.evidencia.sha256_calculado = 'a'.repeat(64), p => p.evidencia.marco = 'registro', p => p.evidencia.campo_ou_evento = 'U. Alterou', p => p.evidencia.fonte.coletado_em = '2026-10-09T20:23:25', p => delete p.evidencia.ato.livro]) {
    const p = pedido(); alterar(p); assert.throws(() => S.validarAutoria(p), e => e.status === 400);
  }
  assert.throws(() => S.validarAutoria({ ...pedido(), colaborador: { id: 'pessoa.1', nome: 'Pessoa Um' }, evidencia: { tipo: 'registro_lavratura_extra', marco: 'registro', referencia: 'fixture', campo_ou_evento: 'Criado Por', valor_original: 'pessoa.1' } }), e => e.status === 400);
});

test('coleta tem data original independente da confirmação e não pode ser futura ou anterior ao ato', () => {
  for (const em of ['2099-10-09T20:00:00Z', '2026-09-05T01:00:00Z']) {
    const p = pedido(); p.evidencia.fonte.coletado_em = em; assert.throws(() => prever(p), codigo('EVIDENCIA_TEMPORAL_INVALIDA'));
  }
});

test('PostgreSQL: troca gerencial explícita, revisão, histórico, expectativa atômica e receitas preservadas', { skip: !process.env.ATOS_TEST_DATABASE_URL }, async t => {
  const admin = new Pool({ connectionString: process.env.ATOS_TEST_DATABASE_URL, max: 1 });
  const schema = 'criador_test_' + randomUUID().replace(/-/g, ''); await admin.query(`CREATE SCHEMA ${schema}`);
  const opts = { connectionString: process.env.ATOS_TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 4 }, pool = new Pool(opts);
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(`CREATE TABLE usuarios(login text PRIMARY KEY,nome text,cargo text); CREATE TABLE escreventes(login text PRIMARY KEY,nome text,ativo boolean);
    INSERT INTO usuarios VALUES('pessoa.1','Pessoa Um','Escrevente'),('pessoa.2','Pessoa Dois','Escrevente'),('cesar.bravo','César Bravo','Tabelião'),('recepcao','Recepção','Atendente');
    INSERT INTO escreventes VALUES('pessoa.1','Pessoa Um',false),('pessoa.2','Pessoa Dois',true);
    CREATE TABLE produtividade_mes(mes text PRIMARY KEY,dados jsonb); INSERT INTO produtividade_mes VALUES('2026-09','{"total":10000.11,"atos":600,"pessoas":[{"nome":"Usuário financeiro","total":10000.11}]}');`);
  const regs = [registro(1), registro(2, 'cesar.bravo'), registro(3), registro(4), registro(5)];
  await S.importar(pool, { operacao_id: fonte.lote_id, fonte: fonte.fonte, meses: [{ mes: '2026-09', ate: '2026-09-30', revisao_base: 0, corte_em: '2026-10-09T20:23:25.387Z', dia_final_completo: true }], registros: regs }, 'admin.fixture');
  const keys = Object.fromEntries((await S.atos(pool, '2026-09-01', '2026-09-30')).itens.map(x => [x.registro.minuta, x.chave]));
  const tables = ['produtividade_mes', 'atos_lavrados_itens', 'atos_lavrados_lotes', 'atos_lavrados_versoes', 'atos_lavrados_meses', 'usuarios', 'escreventes'];
  const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async name => [name, (await pool.query(`SELECT to_jsonb(t) AS linha FROM ${name} t ORDER BY to_jsonb(t)::text`)).rows])));
  const initial = await snapshot();
  // Evidência anterior sintética válida no esquema já publicado, revisão 1 e histórico.
  const oldEvidence = { tipo: 'trello_movimentacao_arquivo_criterio_titular', metodo: 'ultimo_escrevente_antes_arquivo_trello', sha256_calculado: 'b'.repeat(64), corte_em: '2026-10-13T13:35:08.032Z', trello: { cartao_id: 'a'.repeat(24) }, decisao: { cartao_id: 'a'.repeat(24) } };
  for (const table of ['atos_lavrados_autorias', 'atos_lavrados_autoria_historico']) await pool.query(`INSERT INTO ${table}(documento,minuta,revisao,situacao,colaborador_id,colaborador_nome,marco,evidencia,confirmado_por) VALUES('Notas','1',1,'confirmada','pessoa.2','Pessoa Dois','atribuicao_gerencial',$1::jsonb,'admin.anterior')`, [JSON.stringify(oldEvidence)]);
  const p1 = pedido(1, keys[1], 1), d1 = prever(p1), exp1 = expectativa(d1);
  await t.test('substitui revisão 1 por 2 sem apagar histórico ou confundir datas', async () => {
    const r = await S.atribuirAutoria(pool, p1, 'admin.fixture', exp1); assert.equal(r.revisao, 2); assert.equal(r.colaborador.id, 'pessoa.1');
    const h = await S.historicoAutoria(pool, keys[1]); assert.equal(h.length, 2); assert.deepEqual(h[1].evidencia, oldEvidence);
    assert.equal(h[0].evidencia.fonte.coletado_em, '2026-10-09T20:23:25.387Z'); assert.ok(+h[0].confirmado_em > Date.parse(h[0].evidencia.fonte.coletado_em));
    assert.equal(h[0].confirmado_por, 'admin.fixture'); assert.equal(h[1].confirmado_por, 'admin.anterior');
  });
  await t.test('replay exato é idempotente mesmo com revisão original; variação exige revisão atual', async () => {
    const r = await S.atribuirAutoria(pool, p1, 'admin.fixture', exp1); assert.equal(r.repetida, true); assert.equal(r.revisao, 2);
    const p = clone(p1); p.evidencia.fonte.referencia += ' revisada';
    await assert.rejects(S.atribuirAutoria(pool, p, 'admin.fixture'), codigo('REVISAO_DESATUALIZADA'));
    await assert.rejects(S.atribuirAutoria(pool, p1, 'admin.fixture', { ...exp1, sha256_calculado: 'f'.repeat(64) }), codigo('DECISAO_DIVERGENTE_DA_PREVIA'));
    assert.equal((await S.historicoAutoria(pool, keys[1])).length, 2);
  });
  await t.test('escolha vigente substitui direta mediante revisão exata; direta não reverte a escolha', async () => {
    const direta = { chave: keys[3], revisao_base: 0, colaborador: { id: 'pessoa.2', nome: 'Pessoa Dois' }, evidencia: { tipo: 'registro_lavratura_extra', marco: 'registro', referencia: 'evento sintético', campo_ou_evento: 'Usuário de registro', valor_original: 'pessoa.2' } };
    await S.atribuirAutoria(pool, direta, 'admin.fixture');
    const p = pedido(3, keys[3], 0); await assert.rejects(S.atribuirAutoria(pool, p, 'admin.fixture'), codigo('REVISAO_DESATUALIZADA'));
    p.revisao_base = 1; const d = prever(p, regs[2]); assert.equal((await S.atribuirAutoria(pool, p, 'admin.fixture', expectativa(d))).revisao, 2);
    direta.revisao_base = 2; await assert.rejects(S.atribuirAutoria(pool, direta, 'admin.fixture'), codigo('CRITERIO_GERENCIAL_SUPERADO'));
    assert.equal((await S.historicoAutoria(pool, keys[3]))[1].evidencia.tipo, 'registro_lavratura_extra');
  });
  await t.test('rotina antiga não substitui Criado Por mesmo com corte posterior e revisão atual', async () => {
    const f = { referencia: 'fonte sintética posterior', sha256: 'b'.repeat(64), coletado_em: '2026-10-13T13:35:08.032Z', ato: identidade(1) };
    const p = { chave: keys[1], revisao_base: 2, evidencia: { tipo: 'auditoria_trello_criterio_titular', marco: 'atribuicao_gerencial', ato: identidade(1), corte_em: f.coletado_em,
      auditoria: { ...clone(f), completa_ate_corte: true, eventos: [] }, trello: { ...clone(f), cartao_id: 'a'.repeat(24), campo_responsavel: 'Responsável', responsaveis: [] } } };
    assert.equal(S.validarAutoria(p).evidencia.tipo, 'auditoria_trello_criterio_titular');
    await assert.rejects(S.atribuirAutoria(pool, p, 'admin.fixture'), codigo('CRITERIO_GERENCIAL_SUPERADO'));
    assert.equal((await S.historicoAutoria(pool, keys[1])).length, 2);
  });
  await t.test('cadastro alterado após prévia impede escrita antes do INSERT e replay', async () => {
    const p = pedido(4, keys[4]), exp = expectativa(prever(p, regs[3]));
    await pool.query("UPDATE escreventes SET nome='Nome alterado' WHERE login='pessoa.1'");
    try { await assert.rejects(S.atribuirAutoria(pool, p, 'admin.fixture', exp), codigo('DECISAO_DIVERGENTE_DA_PREVIA')); assert.equal((await S.historicoAutoria(pool, keys[4])).length, 0); }
    finally { await pool.query("UPDATE escreventes SET nome='Pessoa Um' WHERE login='pessoa.1'"); }
    await S.atribuirAutoria(pool, p, 'admin.fixture', exp);
  });
  await t.test('Tabelião é confirmado e concorrência exata não duplica o histórico', async () => {
    const p = pedido(2, keys[2], 0, 'cesar.bravo'), exp = expectativa(prever(p, regs[1]));
    const rs = await Promise.all([S.atribuirAutoria(pool, p, 'admin.fixture', exp), S.atribuirAutoria(pool, p, 'admin.fixture', exp)]);
    assert.equal(rs.filter(x => x.repetida).length, 1); assert.equal((await S.historicoAutoria(pool, keys[2])).length, 1);
    assert.equal((await S.historicoAutoria(pool, keys[2]))[0].evidencia.decisao.colaborador.papel, 'tabeliao');
    assert.equal((await pool.query("SELECT count(*)::int n FROM escreventes WHERE login='cesar.bravo'")).rows[0].n, 0);
  });
  await t.test('hash/lote divergentes e pendência não produzem histórico', async () => {
    const p = pedido(5, keys[5]); p.evidencia.fonte.sha256 = 'e'.repeat(64);
    await assert.rejects(S.atribuirAutoria(pool, p, 'admin.fixture'), codigo('FONTE_IMPORTADA_DIVERGENTE'));
    p.evidencia.fonte.sha256 = fonte.fonte.sha256;
    await pool.query("DELETE FROM escreventes WHERE login='pessoa.1'; UPDATE usuarios SET cargo='Atendente' WHERE login='pessoa.1'");
    try { await assert.rejects(S.atribuirAutoria(pool, p, 'admin.fixture'), codigo('PENDENTE_SEM_ATRIBUICAO')); }
    finally { await pool.query("INSERT INTO escreventes VALUES('pessoa.1','Pessoa Um',false); UPDATE usuarios SET cargo='Escrevente' WHERE login='pessoa.1'"); }
    assert.equal((await S.historicoAutoria(pool, keys[5])).length, 0);
  });
  await t.test('nova inicialização mantém CHECK compatível e fontes/receitas/atos intactos', async () => {
    const newPool = new Pool(opts); try { await S.init(newPool); } finally { await newPool.end(); }
    await assert.rejects(pool.query("UPDATE atos_lavrados_autorias SET marco='registro' WHERE minuta='1'"), e => e.code === '23514');
    const r = await S.resumo(pool, '2026-09-01', '2026-09-30', true);
    assert.equal(r.total_oficial, 5); assert.equal(r.autoria.com_autoria_confirmada, 4); assert.equal(r.autoria.sem_autoria_confirmada, 1);
    assert.equal(r.autoria.metodos.criado_por_extra, 4); assert.equal(Object.values(r.autoria.metodos).reduce((a,b) => a+b,0), 4);
    assert.ok(r.colaboradores.every(x => x.fonte === 'Extra Digital' && x.marcos.includes('atribuicao_gerencial')));
    assert.equal(r.colaboradores.find(x => x.id === 'cesar.bravo').total_observado, 1);
    assert.doesNotMatch(JSON.stringify(r), /fixture.csv|valor_original|sha256_calculado|receita_liquida/);
    assert.deepEqual(await snapshot(), initial);
  });
  await t.test('revogação explícita continua disponível e registrada', async () => {
    const r = await S.atribuirAutoria(pool, { chave: keys[2], revisao_base: 1, revogar: true, motivo: 'Revogação sintética pelo titular' }, 'admin.fixture');
    assert.equal(r.revisao, 2); assert.equal(r.situacao, 'revogada'); assert.equal((await S.historicoAutoria(pool, keys[2])).length, 2);
  });
});
