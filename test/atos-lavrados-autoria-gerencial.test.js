'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const express = require('express');
const S = require('../atos-lavrados-db');
const G = require('../atos-lavrados-autoria');
const { createRouter } = require('../atos-lavrados');
const clonar = x => JSON.parse(JSON.stringify(x));
const hash = x => createHash('sha256').update(x).digest('hex');
const canonico = x => Array.isArray(x) ? '[' + x.map(canonico).join(',') + ']' : x && typeof x === 'object' ? '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonico(x[k])).join(',') + '}' : JSON.stringify(x);
const identidade = n => ({ documento: 'Notas', minuta: String(n), protocolo: 'P' + n, livro: '1', folha: String(n) });
const registro = n => ({ ...identidade(n), data_lavratura: '2026-10-05', status: 4, status_nome: 'Registrado(a)', originais: { Finalidade: 'Compra e venda', 'Sub-tipo': 'Escritura com Valor' } });
const pessoa = n => ({ id: 'pessoa.' + n, nome: 'Escrevente ' + n });
const evento = (n, em, id = 'evento-' + n) => ({ id, em, acao: 'alteracao_minuta', usuario_original: pessoa(n).id, colaborador: pessoa(n) });
const cadastro = [1, 2].map(n => ({ login: pessoa(n).id, nome: pessoa(n).nome, escrevente: true, aliases: [] })).concat([{ login: 'recepcao', nome: 'Recepção Fictícia', escrevente: false, aliases: [] }]);
function pedido(n = 1, chave = 'a'.repeat(64), rev = 0) {
  const ato = identidade(n), coleta = '2026-10-09T17:05:00-03:00';
  return { chave, revisao_base: rev, evidencia: { tipo: G.TIPO, marco: 'atribuicao_gerencial', corte_em: '2026-10-09T17:00:00-03:00', ato,
    auditoria: { referencia: 'captura sintética da auditoria integral', sha256: 'a'.repeat(64), coletado_em: coleta, ato: clonar(ato), completa_ate_corte: true,
      eventos: [evento(1, '2026-10-05T09:00:00-03:00'), evento(2, '2026-10-05T10:00:00-03:00'),
        { id: 'recepcao-3', em: '2026-10-05T11:00:00-03:00', acao: 'alteracao_protocolo', usuario_original: 'recepcao', colaborador: null }] },
    trello: { referencia: 'captura sintética do campo explícito', sha256: 'b'.repeat(64), coletado_em: coleta, ato: clonar(ato), cartao_id: 'c'.repeat(24), campo_responsavel: 'Escrevente responsável',
      responsaveis: [{ valor_original: 'pessoa.2', colaborador: pessoa(2) }] } } };
}
const decidir = (p, c = cadastro) => G.decidir(S.validarAutoria(p), registro(Number(p.evidencia.ato.minuta)), c, { erro: S.erro, hash, canonico, agora: new Date('2026-10-10T03:00:00Z') });
const esperaPendente = (fn, codigo) => assert.throws(fn, e => e.status === 422 && e.codigo === 'PENDENTE_SEM_ATRIBUICAO' && e.pendencias.includes(codigo));

test('complemento deriva concordância/divergência do último escrevente, não do último operador', () => {
  const p = pedido(); p.evidencia.auditoria.eventos.reverse();
  let r = decidir(p); assert.equal(r.evidencia.metodo, 'auditoria_concordante'); assert.deepEqual(r.colaborador, pessoa(2));
  assert.equal(r.evidencia.decisao.ultimo_evento_id, 'evento-2'); assert.equal(r.marco, 'atribuicao_gerencial');
  p.evidencia.trello.responsaveis = [{ valor_original: 'pessoa.1', colaborador: pessoa(1) }];
  r = decidir(p); assert.equal(r.evidencia.metodo, 'trello_divergencia'); assert.deepEqual(r.colaborador, pessoa(1));
  assert.deepEqual(r.evidencia.decisao.ultimo_escrevente, pessoa(2));
  const { sha256_calculado, ...semHash } = r.evidencia; assert.equal(sha256_calculado, hash(canonico(semHash)));
  assert.equal(p.evidencia.metodo, undefined); // não modifica o original
});

test('identidades canônicas verificam texto original e conservam nomes/valores sem inferência', () => {
  const p = pedido(); p.evidencia.auditoria.eventos[1].usuario_original = '  PESSOA.2  ';
  p.evidencia.auditoria.eventos[1].colaborador = { id: 'PESSOA.2', nome: 'ESCREVENTE 2' };
  let r = decidir(p); assert.equal(r.evidencia.auditoria.eventos[1].usuario_original, '  PESSOA.2  '); assert.deepEqual(r.colaborador, pessoa(2));
  p.evidencia.auditoria.eventos[1].colaborador = pessoa(1);
  esperaPendente(() => decidir(p), 'AUDITORIA_COLABORADOR_DIVERGENTE');
  p.evidencia.auditoria.eventos[1].usuario_original = '(MEMO)';
  esperaPendente(() => decidir(p), 'AUDITORIA_IDENTIDADE_NAO_CONFERIDA');
  const duplicado = cadastro.concat([{ login: 'homonimo', nome: 'Escrevente 2', escrevente: true, aliases: [] }]);
  const outro = pedido(); outro.evidencia.auditoria.eventos[1].usuario_original = 'Escrevente 2';
  esperaPendente(() => decidir(outro, duplicado), 'AUDITORIA_IDENTIDADE_NAO_CONFERIDA');
});

test('últimos eventos simultâneos da mesma escrevente confirmam uma atribuição e preservam todos os IDs', () => {
  const p = pedido(); p.evidencia.auditoria.eventos.push(evento(2, '2026-10-05T10:00:00-03:00', 'evento-2b'));
  p.evidencia.auditoria.eventos.reverse();
  const r = decidir(p); assert.deepEqual(r.colaborador, pessoa(2)); assert.equal(r.evidencia.metodo, 'auditoria_concordante');
  assert.deepEqual(r.evidencia.decisao.ultimos_eventos_ids, ['evento-2', 'evento-2b']); assert.equal(r.evidencia.decisao.ultimo_evento_id, null);
  assert.equal(r.evidencia.auditoria.eventos.length, 4);
});

test('ausência/ambiguidade de prova permanece pendente e não escolhe colaborador', () => {
  const casos = [
    [p => p.evidencia.auditoria.completa_ate_corte = false, 'AUDITORIA_INCOMPLETA'],
    [p => p.evidencia.auditoria.eventos = [], 'SEM_ULTIMO_ESCREVENTE'],
    [p => p.evidencia.auditoria.eventos = [p.evidencia.auditoria.eventos[2]], 'SEM_ULTIMO_ESCREVENTE'],
    [p => p.evidencia.trello.responsaveis = [], 'TRELLO_RESPONSAVEL_NAO_UNICO'],
    [p => p.evidencia.trello.responsaveis.push({ valor_original: 'pessoa.1', colaborador: pessoa(1) }), 'TRELLO_RESPONSAVEL_NAO_UNICO'],
    [p => p.evidencia.trello.responsaveis = [{ valor_original: 'recepcao' }], 'TRELLO_RESPONSAVEL_NAO_ESCREVENTE'],
    [p => p.evidencia.auditoria.eventos.push(evento(1, '2026-10-05T10:00:00-03:00', 'empate')), 'ULTIMO_EVENTO_AMBIGUO']
  ];
  for (const [alterar, codigo] of casos) { const p = pedido(); alterar(p); esperaPendente(() => decidir(p), codigo); }
});

test('estrutura exige identidade completa, hash, referência, instante com fuso e decisão do servidor', () => {
  const casos = [p => p.colaborador = pessoa(1), p => p.evidencia.metodo = 'trello_divergencia', p => p.evidencia.marco = 'registro',
    p => p.evidencia.trello.ato.minuta = '2', p => delete p.evidencia.auditoria.ato.livro,
    p => p.evidencia.trello.cartao_id = 'url-curta', p => p.evidencia.auditoria.sha256 = 'x'.repeat(64),
    p => p.evidencia.trello.referencia = '', p => p.evidencia.corte_em = '2026-10-09T17:00:00',
    p => p.evidencia.auditoria.coletado_em = '2026-10-08T17:00:00-03:00',
    p => p.evidencia.auditoria.eventos[0].em = '2026-10-09T17:01:00-03:00',
    p => p.evidencia.auditoria.eventos[0].id = 'evento-2',
    p => p.evidencia.auditoria.eventos[0].acao = 'criacao',
    p => p.evidencia.auditoria.eventos[0].colaborador.id = '<script>',
    p => p.evidencia.auditoria.eventos[0].usuario_original = '\u0000'];
  for (const alterar of casos) { const p = pedido(); alterar(p); assert.throws(() => S.validarAutoria(p), e => e.status === 400); }
  const p = S.validarAutoria(pedido()); assert.throws(() => G.decidir(p, registro(2), cadastro, { erro: S.erro, hash, canonico }), e => e.codigo === 'IDENTIDADE_DIVERGENTE');
});

test('tempo da fonte não aceita futuro nem corte anterior à lavratura, observando o dia de Brasília', () => {
  for (const alterar of [
    p => { p.evidencia.corte_em = '2099-10-09T17:00:00-03:00'; p.evidencia.auditoria.coletado_em = p.evidencia.trello.coletado_em = '2099-10-09T17:05:00-03:00'; },
    p => { p.evidencia.auditoria.coletado_em = '2099-10-09T17:05:00-03:00'; },
    p => { p.evidencia.trello.coletado_em = '2099-10-09T17:05:00-03:00'; },
    p => { p.evidencia.corte_em = '2020-10-09T17:00:00-03:00'; p.evidencia.auditoria.eventos = []; },
    p => { p.evidencia.corte_em = '2026-10-05T01:00:00Z'; p.evidencia.auditoria.eventos = []; }
  ]) { const p = pedido(); alterar(p); assert.throws(() => decidir(p), e => e.codigo === 'EVIDENCIA_TEMPORAL_INVALIDA' && e.status === 400); }
});

test('PostgreSQL: prioridade direta, revisão, pendência sem mutação, métodos e histórico', { skip: !process.env.ATOS_TEST_DATABASE_URL }, async t => {
  const admin = new Pool({ connectionString: process.env.ATOS_TEST_DATABASE_URL, max: 1 });
  const schema = 'autoria_test_' + randomUUID().replace(/-/g, ''); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.ATOS_TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 4 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  // Instala o schema antigo antes de init, provando a migração de uma atribuição já existente.
  await pool.query(await fs.readFile(path.join(__dirname, '../migrations/20261009-atos-lavrados-autoria.sql'), 'utf8'));
  await pool.query(`INSERT INTO atos_lavrados_autorias(documento,minuta,revisao,situacao,colaborador_id,colaborador_nome,marco,evidencia,confirmado_por)
    VALUES('Notas','3',1,'confirmada',' PESSOA.1 ','Escrevente 1','registro','{"tipo":"registro_lavratura_extra"}'::jsonb,'admin.antigo')`);
  await pool.query(`CREATE TABLE usuarios(login text PRIMARY KEY,nome text,cargo text);
    CREATE TABLE escreventes(login text PRIMARY KEY,nome text,ativo boolean);
    INSERT INTO usuarios VALUES('pessoa.1','Escrevente 1','Escrevente'),('pessoa.2','Escrevente 2','Escrevente'),('recepcao','Recepção Fictícia','Recepção');
    INSERT INTO escreventes VALUES('pessoa.1','Escrevente 1',true),('pessoa.2','Escrevente 2',false)`);
  await S.importar(pool, { operacao_id: randomUUID(), fonte: { sistema: 'Extra Digital', arquivo: 'sintetico.csv', sha256: 'd'.repeat(64) },
    meses: [{ mes: '2026-10', ate: '2026-10-12', revisao_base: 0, corte_em: '2026-10-12T17:00:00-03:00', dia_final_completo: false }], registros: [1, 2, 3, 4, 5].map(registro) }, 'admin.fixture');
  const keys = Object.fromEntries((await S.atos(pool, '2026-10-01', '2026-10-31')).itens.map(x => [x.registro.minuta, x.chave]));
  const app = express(); app.use('/hub/atos-lavrados', createRouter({ pool, session: async token => token ? { login: token } : null, ehAdmin: u => u.login === 'admin.fixture' }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const post = (p, token = 'admin.fixture') => fetch(`http://127.0.0.1:${server.address().port}/hub/atos-lavrados/autorias`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Auth-Token': token } : {}) }, body: JSON.stringify(p) });
  await t.test('401/403 e concorrência: só uma decisão confirmada, incluindo escrevente desligado', async () => {
    const p = pedido(1, keys[1]);
    assert.equal((await post(p, '')).status, 401); assert.equal((await post(p, 'outra.pessoa')).status, 403);
    const res = await Promise.all([post(p), post(p)]); assert.deepEqual(res.map(x => x.status).sort(), [200, 409]);
    const r = await res.find(x => x.status === 200).json(); assert.deepEqual(r.colaborador, pessoa(2)); assert.equal(r.metodo, 'auditoria_concordante');
  });
  await t.test('divergência deriva responsável Trello e fontes não vazam no resumo', async () => {
    const p = pedido(2, keys[2]); p.evidencia.trello.responsaveis = [{ valor_original: 'pessoa.1', colaborador: pessoa(1) }];
    assert.equal((await post(p)).status, 200);
    const r = await S.semana(pool, '2026-10-09');
    assert.deepEqual(r.autoria.metodos, { direta: 1, auditoria_concordante: 1, trello_divergencia: 1 });
    assert.equal(r.autoria.sem_autoria_confirmada, 2); assert.equal(r.autoria.com_autoria_confirmada, 3);
    assert.equal(r.colaboradores.length, 2); assert.equal(r.colaboradores.find(x => x.id === 'pessoa.1').total_observado, 2);
    for (const c of r.colaboradores) assert.equal(Object.values(c.metodos).reduce((n, x) => n + x, 0), c.total_observado);
    assert.ok(r.colaboradores.every(x => x.fonte === 'Extra Digital + Trello'));
    assert.doesNotMatch(JSON.stringify(r), /captura sintética|evento-2|sha256_calculado/);
  });
  await t.test('direta protege-se de complemento e pode substituir complemento por nova revisão', async () => {
    let r = await post(pedido(3, keys[3], 1)); assert.equal(r.status, 409); assert.equal((await r.json()).codigo, 'AUTORIA_DIRETA_PRIORITARIA');
    const direta = { chave: keys[1], revisao_base: 1, colaborador: pessoa(1), evidencia: { tipo: 'registro_lavratura_extra', marco: 'lavratura', referencia: 'evento direto sintético', campo_ou_evento: 'Usuário de lavratura', valor_original: 'pessoa.1' } };
    direta.colaborador.id = ' PESSOA.1 ';
    assert.equal(S.validarAutoria(direta).colaborador.id, 'pessoa.1');
    assert.equal((await post(direta)).status, 200);
    const h = await S.historicoAutoria(pool, keys[1]); assert.equal(h.length, 2); assert.equal(h[0].evidencia.tipo, 'registro_lavratura_extra');
    assert.equal(h[1].evidencia.metodo, 'auditoria_concordante'); assert.equal(h[1].confirmado_por, 'admin.fixture');
    assert.equal(h[0].colaborador_id, 'pessoa.1'); assert.equal(h[0].evidencia.valor_original, 'pessoa.1');
    const { sha256_calculado, ...semHash } = h[1].evidencia; assert.equal(sha256_calculado, hash(canonico(semHash)));
    assert.equal((await post(pedido(1, keys[1], 2))).status, 409);
  });
  await t.test('pendência retorna 422 estruturado sem apagar, rebaixar ou criar revisão', async () => {
    const before = await S.historicoAutoria(pool, keys[2]);
    for (const n of [2, 4]) {
      const p = pedido(n, keys[n], n === 2 ? 1 : 0); p.evidencia.trello.responsaveis = [];
      const r = await post(p); assert.equal(r.status, 422); assert.equal(r.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(await r.json(), { erro: 'evidências insuficientes ou ambíguas; nenhuma atribuição foi alterada', codigo: 'PENDENTE_SEM_ATRIBUICAO', pendencias: ['TRELLO_RESPONSAVEL_NAO_UNICO'] });
    }
    assert.deepEqual(await S.historicoAutoria(pool, keys[2]), before); assert.equal((await S.historicoAutoria(pool, keys[4])).length, 0);
    assert.equal((await S.semana(pool, '2026-10-09')).autoria.com_autoria_confirmada, 3);
    const temporal = pedido(2, keys[2], 1); temporal.evidencia.trello.coletado_em = '2099-10-09T17:05:00-03:00';
    const r = await post(temporal); assert.equal(r.status, 400); assert.equal((await r.json()).codigo, 'EVIDENCIA_TEMPORAL_INVALIDA');
    assert.deepEqual(await S.historicoAutoria(pool, keys[2]), before);
  });
  await t.test('corte antigo não substitui complemento mais recente, mesmo com revisão-base atual', async () => {
    const before = await S.historicoAutoria(pool, keys[2]);
    const p = pedido(2, keys[2], 1); p.evidencia.corte_em = '2026-10-06T17:00:00-03:00';
    const r = await post(p); assert.equal(r.status, 409); assert.equal((await r.json()).codigo, 'EVIDENCIA_ANTIGA');
    assert.deepEqual(await S.historicoAutoria(pool, keys[2]), before);
    assert.equal(before[0].colaborador_id, 'pessoa.1'); // pedido antigo tentava trocar para pessoa.2
  });
  await t.test('revogação é explícita; CHECK impede fingir que fallback é registro direto', async () => {
    await assert.rejects(pool.query("UPDATE atos_lavrados_autorias SET marco='registro' WHERE minuta='2'"), e => e.code === '23514');
    assert.equal((await post({ chave: keys[2], revisao_base: 1, revogar: true, motivo: 'Conferência humana revogou a associação de teste' })).status, 200);
    const h = await S.historicoAutoria(pool, keys[2]); assert.equal(h.length, 2); assert.equal(h[0].situacao, 'revogada');
    const r = await S.semana(pool, '2026-10-09'); assert.deepEqual(r.autoria.metodos, { direta: 2, auditoria_concordante: 0, trello_divergencia: 0 });
    assert.equal(r.autoria.sem_autoria_confirmada, 3); assert.equal(r.total_oficial, 5);
  });
});
