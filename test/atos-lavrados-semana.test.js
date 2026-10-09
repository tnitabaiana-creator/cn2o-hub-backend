'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const express = require('express');
const S = require('../atos-lavrados-db');
const T = require('../atos-lavrados-tipos');
const { createRouter } = require('../atos-lavrados');

test('semana civil segunda–domingo, inclusive na virada de mês/ano e meia-noite de Brasília', () => {
  assert.deepEqual(S.periodoSemanal('2026-10-09'), { referencia: '2026-10-09', fuso: 'America/Sao_Paulo', inicio: '2026-10-05', fim: '2026-10-11' });
  assert.equal(S.periodoSemanal('2026-10-11').inicio, '2026-10-05');
  assert.equal(S.periodoSemanal('2026-10-12').inicio, '2026-10-12');
  assert.equal(S.periodoSemanal('2026-10-01').inicio, '2026-09-28');
  assert.equal(S.periodoSemanal('2027-01-01').inicio, '2026-12-28');
  assert.equal(S.periodoSemanal(undefined, new Date('2026-10-12T01:00:00Z')).referencia, '2026-10-11');
  assert.equal(S.periodoSemanal(undefined, new Date('2026-10-12T03:00:00Z')).inicio, '2026-10-12');
  for (const ref of ['', '2026-02-30', ['2026-10-09']]) assert.throws(() => S.periodoSemanal(ref), e => e.status === 400);
});

test('tipos usam somente campo específico ou finalidade explícita; genéricos e conflitos ficam pendentes', () => {
  const esperado = [
    [{ subtipo: 'Escritura de Inventário', finalidade: 'INV-100' }, 'inventario_partilha', 'Sub-tipo'],
    [{ subtipo: 'Escritura com Valor', finalidade: 'Compra e venda - CLIENTE FICTÍCIO' }, 'compra_venda', 'Finalidade'],
    [{ subtipo: 'Escritura com Valor', finalidade: 'CV-T100' }, 'compra_venda', 'Finalidade'],
    [{ subtipo: 'Escritura sem Valor', finalidade: 'Declaração de União Estável' }, 'uniao_estavel', 'Finalidade'],
    [{ subtipo: 'Escritura com Valor', finalidade: 'Cessão de direitos hereditários' }, 'cessao_heranca', 'Finalidade'],
    [{ subtipo: 'Escritura com Valor', finalidade: 'CDP-123' }, 'cessao_posse', 'Finalidade'],
    [{ subtipo: 'Ata notarial', finalidade: 'constatação em meio digital' }, 'ata_notarial', 'Sub-tipo'],
    [{ subtipo: 'Escritura de rerratificação sem valor', finalidade: 'Rerratificação de escritura de compra e venda' }, 'rerratificacao', 'Sub-tipo'],
    [{ subtipo: 'Revogacao', finalidade: 'Revogação de procuração' }, 'revogacao', 'Sub-tipo'],
    [{ subtipo: 'Escritura com Valor', finalidade: '' }, 'nao_classificado', null],
    [{ subtipo: 'Escritura sem Valor', finalidade: 'documentos CV recebidos' }, 'nao_classificado', null],
    [{ subtipo: 'Escritura com Valor', finalidade: 'CPD-123' }, 'nao_classificado', null],
    [{ subtipo: 'Escritura com Valor', finalidade: 'Procuração' }, 'nao_classificado', null]
  ];
  for (const [entrada, codigo, origem] of esperado) assert.deepEqual(T.classificar(entrada), { codigo, origem, divergente: false });
  assert.deepEqual(T.classificar({ subtipo: 'Escritura de Inventário', finalidade: 'Compra e venda' }), { codigo: 'nao_classificado', origem: null, divergente: true });
});

test('distribuição soma observados, mantém oficiais nulos quando parcial e não expõe finalidade/nome', () => {
  const grupos = [{ subtipo: 'Escritura com Valor', finalidade: 'CV - CLIENTE FICTÍCIO', total: 3 },
    { subtipo: 'Escritura com Valor', finalidade: 'sem indicação', total: 2 },
    { subtipo: 'Escritura de Inventário', finalidade: 'Doação', total: 1 }];
  const r = T.distribuir(grupos, false);
  assert.equal(r.tipos.reduce((n, x) => n + x.total_observado, 0), 6);
  assert.ok(r.tipos.every(x => x.total_oficial === null));
  assert.equal(r.classificacao.nao_classificados, 3); assert.equal(r.classificacao.divergentes, 1);
  assert.equal(r.classificacao.por_finalidade, 3); assert.equal(r.classificacao.por_subtipo, 0);
  assert.doesNotMatch(JSON.stringify(r), /CLIENTE FICTÍCIO|sem indicação/);
  assert.equal(T.distribuir(grupos, true).tipos.reduce((n, x) => n + x.total_oficial, 0), 6);
});

const ato = (n, data_lavratura, subtipo, finalidade) => ({ minuta: String(n), protocolo: String(n), livro: '1', folha: String(n), documento: 'Notas', data_lavratura,
  status: 4, status_nome: 'Registrado(a)', originais: { 'Sub-tipo': subtipo, Finalidade: finalidade, 'U. criador': 'OPERADOR FICTÍCIO', 'U. Alterou': 'OUTRO OPERADOR' } });
const lote = (meses, registros) => ({ operacao_id: randomUUID(), fonte: { sistema: 'Extra Digital', arquivo: 'sintetico.csv', sha256: 'a'.repeat(64) }, meses, registros });
const cobertura = (mes, ate, corte_em, dia_final_completo, revisao_base = 0) => ({ mes, ate, corte_em, dia_final_completo, revisao_base });
const atribuicao = (chave, id = 'colaborador-1', nome = 'Escrevente Fictícia A') => ({ chave, revisao_base: 0, colaborador: { id, nome },
  evidencia: { tipo: 'registro_lavratura_extra', marco: 'registro', referencia: 'Histórico de teste, evento REG-1', campo_ou_evento: 'Usuário do evento de registro', valor_original: '  operador.registro  ' } });

test('atribuição exige evidência específica e nunca aceita criador, alteração ou protocolo como autoria', () => {
  const p = atribuicao('a'.repeat(64));
  assert.equal(S.validarAutoria(p).evidencia.valor_original, '  operador.registro  ');
  for (const alterar of [x => delete x.evidencia, x => x.evidencia.tipo = 'suposicao', x => x.evidencia.marco = 'criacao',
    x => x.evidencia.referencia = '', x => x.evidencia.valor_original = '', x => x.colaborador.id = '',
    ...['U. criador', 'Criado Por', 'U. Alterou', 'Última alteração', 'Protocolado por'].map(campo => x => x.evidencia.campo_ou_evento = campo)]) {
    const x = JSON.parse(JSON.stringify(p)); alterar(x); assert.throws(() => S.validarAutoria(x), e => e.status === 400);
  }
  assert.equal(S.validarAutoria({ chave: p.chave, revisao_base: 1, revogar: true, motivo: 'Correção documental' }).situacao, 'revogada');
});

test('PostgreSQL: sexta parcial, complemento do fim de semana, autoria e semana entre meses', { skip: !process.env.ATOS_TEST_DATABASE_URL }, async t => {
  const admin = new Pool({ connectionString: process.env.ATOS_TEST_DATABASE_URL, max: 1 });
  const schema = 'semana_test_' + randomUUID().replace(/-/g, ''); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.ATOS_TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 3 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const reqApp = express(); reqApp.use('/hub/atos-lavrados', createRouter({ pool, session: async token => token === 'admin' ? { login: 'admin.fixture' } : null, ehAdmin: () => true }));
  const server = await new Promise(resolve => { const srv = reqApp.listen(0, '127.0.0.1', () => resolve(srv)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const pedir = (rota, autenticado = true, body) => fetch(`http://127.0.0.1:${server.address().port}/hub/atos-lavrados${rota}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...(autenticado ? { 'X-Auth-Token': 'admin' } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const registros = [ato(1, '2026-10-05', 'Escritura com Valor', 'Compra e venda'), ato(2, '2026-10-09', 'Escritura de Inventário', 'Inventário'),
    ato(3, '2026-10-09', 'Escritura com Valor', '')];
  await S.importar(pool, lote([cobertura('2026-10', '2026-10-09', '2026-10-09T17:00:00-03:00', false)], registros), 'admin.fixture');
  await t.test('sexta17h não fecha semana; GET autenticado expõe só grupos sem autoria inventada', async () => {
    assert.equal((await pedir('/semana?referencia=2026-10-09', false)).status, 401);
    assert.equal((await pedir('/semana?referencia=2026-02-30')).status, 400);
    const resposta = await pedir('/semana?referencia=2026-10-09'); assert.equal(resposta.headers.get('cache-control'), 'private, no-store');
    const r = await resposta.json(); assert.equal(r.inicio, '2026-10-05'); assert.equal(r.fim, '2026-10-11');
    assert.equal(r.total_observado, 3); assert.equal(r.total_oficial, null); assert.equal(r.cobertura_completa, false);
    assert.equal(r.meses[0].corte_em, '2026-10-09T20:00:00.000Z');
    assert.equal(r.tipos.reduce((n, x) => n + x.total_observado, 0), 3); assert.equal(r.classificacao.nao_classificados, 1);
    assert.deepEqual(r.colaboradores, []); assert.equal(r.autoria.sem_autoria_confirmada, 3); assert.equal(r.autoria.status, 'pendente');
    assert.doesNotMatch(JSON.stringify(r), /OPERADOR FICTÍCIO|OUTRO OPERADOR/);
  });
  await t.test('nova fotografia inclui atos tardios, sábado e domingo sem duplicar os anteriores', async () => {
    registros.push(ato(4, '2026-10-09', 'Escritura com Valor', 'Doação'), ato(5, '2026-10-10', 'Ata notarial', ''), ato(6, '2026-10-11', 'Escritura com Valor', 'Compra e venda'));
    await S.importar(pool, lote([cobertura('2026-10', '2026-10-12', '2026-10-12T17:00:00-03:00', false, 1)], registros), 'admin.fixture');
    const r = await S.semana(pool, '2026-10-09'); assert.equal(r.total_oficial, 6); assert.equal(r.cobertura_completa, true);
    assert.equal(r.tipos.reduce((n, x) => n + x.total_oficial, 0), 6); assert.equal(r.autoria.sem_autoria_confirmada, 6);
    const mensal = await (await pedir('/resumo?inicio=2026-10-01&fim=2026-10-31')).json();
    assert.equal(mensal.total_oficial, null); assert.equal(mensal.total_observado, 6); assert.ok(mensal.tipos.every(x => x.total_oficial === null));
  });
  await t.test('semana atravessando meses exige ambos e devolve suas coberturas separadas', async () => {
    const antes = await S.semana(pool, '2026-10-01'); assert.equal(antes.total_oficial, null); assert.equal(antes.meses.length, 1);
    await S.importar(pool, lote([cobertura('2026-09', '2026-09-30', '2026-10-09T17:00:00-03:00', true)], [ato(7, '2026-09-30', 'Escritura com Valor', 'Compra e venda')]), 'admin.fixture');
    const r = await S.semana(pool, '2026-10-01'); assert.equal(r.total_oficial, 1); assert.equal(r.meses.length, 2);
    assert.equal(r.tipos[0].codigo, 'compra_venda'); assert.equal(r.tipos[0].total_oficial, 1);
  });
  await t.test('autoria por evidência: concorrência, agrupamento, pendências e histórico preservado', async () => {
    const itens = (await S.atos(pool, '2026-10-05', '2026-10-11')).itens;
    const p = atribuicao(itens[0].chave);
    assert.equal((await pedir('/autorias', false, p)).status, 401);
    const respostas = await Promise.all([pedir('/autorias', true, p), pedir('/autorias', true, p)]);
    assert.deepEqual(respostas.map(x => x.status).sort(), [200, 409]);
    let r = await S.semana(pool, '2026-10-09'); assert.equal(r.autoria.status, 'parcial');
    assert.equal(r.autoria.sem_autoria_confirmada, 5); assert.equal(r.colaboradores[0].total_observado, 1); assert.equal(r.colaboradores[0].total_oficial, null);
    assert.equal(r.total_oficial, 6); // cobertura dos atos é completa, atribuição individual ainda não
    for (let i = 1; i < itens.length; i++) {
      const outro = atribuicao(itens[i].chave, i < 3 ? 'colaborador-1' : 'colaborador-2', i < 3 ? 'Escrevente Fictícia A' : 'Escrevente Fictícia B');
      if (i === 1) outro.evidencia.marco = 'lavratura';
      assert.equal((await pedir('/autorias', true, outro)).status, 200);
    }
    r = await S.semana(pool, '2026-10-09'); assert.equal(r.autoria.status, 'confirmada'); assert.equal(r.autoria.cobertura_completa, true);
    assert.equal(r.autoria.sem_autoria_confirmada, 0); assert.equal(r.autoria.com_autoria_confirmada, 6);
    assert.deepEqual(r.colaboradores.map(x => x.total_oficial), [3, 3]);
    assert.deepEqual(r.colaboradores[0].marcos, ['lavratura', 'registro']); assert.equal(r.colaboradores[0].fonte, 'Extra Digital');
    const h = (await (await pedir('/autorias/' + p.chave + '/historico')).json()).historico;
    assert.equal(h[0].confirmado_por, 'admin.fixture'); assert.equal(h[0].evidencia.valor_original, p.evidencia.valor_original);
  });
  await t.test('nova fotografia/correção de protocolo preserva autoria por identidade; revogação deixa pendência com histórico', async () => {
    const antes = (await S.atos(pool, '2026-10-05', '2026-10-11')).itens.find(x => x.registro.minuta === '1');
    registros[0].protocolo = 'PROTOCOLO-CORRIGIDO';
    await S.importar(pool, lote([cobertura('2026-10', '2026-10-12', '2026-10-12T17:00:00-03:00', false, 2)], registros), 'admin.fixture');
    const depois = (await S.atos(pool, '2026-10-05', '2026-10-11')).itens.find(x => x.registro.minuta === '1');
    assert.notEqual(depois.chave, antes.chave);
    assert.equal((await S.semana(pool, '2026-10-09')).autoria.com_autoria_confirmada, 6);
    assert.equal((await pedir('/autorias', true, { chave: depois.chave, revisao_base: 1, revogar: true, motivo: 'Evidência substituída; aguardando conferência' })).status, 200);
    const r = await S.semana(pool, '2026-10-09'); assert.equal(r.autoria.sem_autoria_confirmada, 1);
    assert.equal(r.colaboradores.reduce((n, x) => n + x.total_observado, 0), 5); assert.ok(r.colaboradores.every(x => x.total_oficial === null));
    const h = await S.historicoAutoria(pool, antes.chave); assert.equal(h.length, 2); assert.equal(h[0].situacao, 'revogada'); assert.equal(h[1].situacao, 'confirmada');
  });
});
