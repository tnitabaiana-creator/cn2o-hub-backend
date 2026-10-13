'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Pool } = require('pg');
const express = require('express');
const S = require('../atos-lavrados-db');
const A = require('../atos-lavrados-arquivo-trello');
const { createRouter } = require('../atos-lavrados');
const clone = x => JSON.parse(JSON.stringify(x));
const id = n => Number(n).toString(16).padStart(24, '0');
const pessoa = n => ({ id: 'pessoa.' + n, nome: 'Escrevente ' + n });
const ator = n => ({ id: id(n), nome: pessoa(n).nome, username: pessoa(n).id, tipo: 'humano', colaborador_hub: pessoa(n) });
const tn = () => ({ id: id(99), nome: 'TN Itabaiana', username: 'tnitabaiana', tipo: 'humano' });
const identidade = n => ({ documento: 'Notas', minuta: String(n), protocolo: 'P' + n, livro: '1', folha: String(n) });
const registro = n => ({ ...identidade(n), data_lavratura: '2026-09-01', status: 4, status_nome: 'Registrado(a)', originais: { 'Sub-tipo': 'Escritura com Valor', Finalidade: 'Compra e venda' } });
const cadastro = [1, 2].map(n => ({ login: pessoa(n).id, nome: pessoa(n).nome, escrevente: true, aliases: [] })).concat([{ login: 'recepcao', nome: 'Recepção Fictícia', escrevente: false, aliases: [] }]);
const movimento = (n, criador, date, before = id(900), after = A.LISTAS[0]) => ({ id: id(n), type: 'updateCard', date, cartao_id: id(500), quadro_id: A.QUADRO,
  listBefore: { id: before, name: 'Lista sintética de origem' }, listAfter: { id: after, name: 'Lista sintética de destino' }, criador });
function pedido(n = 1, chave = 'a'.repeat(64), revisao_base = 0) {
  const ato = identidade(n), fonte = { referencia: 'fonte sintética preservada em teste', sha256: 'a'.repeat(64), coletado_em: '2026-10-12T17:05:00-03:00', ato, cartao_id: id(500) };
  return { chave, revisao_base, evidencia: { tipo: A.TIPO, marco: 'atribuicao_gerencial', corte_em: '2026-10-12T17:00:00-03:00', ato,
    vinculo: { ...clone(fonte), confirmado_unico: true }, trello: { ...clone(fonte), quadro: { id: A.QUADRO, nome: '00. Protocolo/Cadastro' }, listas_arquivo: A.LISTAS.map(id => ({ id, nome: 'Arquivo conferido' })), historico_completo_ate_corte: true,
      movimentacoes: [movimento(101, ator(1), '2026-09-05T09:00:00-03:00'), movimento(102, tn(), '2026-09-06T10:00:00-03:00', A.LISTAS[0], A.LISTAS[1])] } } };
}
function anterior(p) {
  p.evidencia.trello.movimentacoes = [movimento(103, ator(2), '2026-09-03T08:00:00-03:00', id(901), id(902)),
    movimento(104, ator(1), '2026-09-04T10:00:00-03:00', id(902), id(903)),
    movimento(105, tn(), '2026-09-05T09:00:00-03:00', id(903), A.LISTAS[0]),
    movimento(106, tn(), '2026-09-06T10:00:00-03:00', A.LISTAS[0], A.LISTAS[2])];
  return p;
}
const canonico = x => Array.isArray(x) ? '[' + x.map(canonico).join(',') + ']' : x && typeof x === 'object' ? '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonico(x[k])).join(',') + '}' : JSON.stringify(x);
const hash = x => createHash('sha256').update(x).digest('hex');
const decidir = (p, pessoas = cadastro) => A.decidir(S.validarAutoria(p), registro(Number(p.evidencia.ato.minuta)), pessoas,
  { erro: S.erro, hash, canonico, agora: new Date('2026-10-13T23:00:00Z') });
const pendente = (fn, codigo) => assert.throws(fn, e => e.status === 422 && e.codigo === 'PENDENTE_SEM_ATRIBUICAO' && e.pendencias.includes(codigo));

test('conta da última entrada recebe crédito; reorganização entre arquivos não reatribui', () => {
  const p = pedido(), original = clone(p); p.evidencia.trello.movimentacoes.reverse();
  const r = decidir(p); assert.equal(r.evidencia.metodo, A.METODO); assert.deepEqual(r.colaborador, pessoa(1));
  assert.equal(r.evidencia.decisao.marco_arquivo.acoes_ids[0], id(101));
  assert.equal(r.evidencia.decisao.origem_execucao, 'fonte_nao_informa');
  assert.equal(r.evidencia.trello.movimentacoes[0].automacao, null); assert.equal(r.evidencia.trello.movimentacoes[0].appCreator, null);
  assert.equal(r.evidencia.auditoria, undefined); assert.equal(p.evidencia.metodo, undefined);
  const { sha256_calculado, ...sem } = r.evidencia; assert.equal(sha256_calculado, hash(canonico(sem)));
  assert.deepEqual(original.evidencia.ato, r.evidencia.ato);
  // Não deixa o pedido reclassificar uma lista aprovada omitindo-a da declaração.
  p.evidencia.trello.movimentacoes = [movimento(200, ator(2), '2026-09-07T10:00:00Z', A.LISTAS[1], A.LISTAS[0])];
  p.evidencia.trello.listas_arquivo = [{ id: A.LISTAS[0], nome: 'Arquivo' }];
  pendente(() => decidir(p), 'SEM_ENTRADA_COMPROVADA_NO_ARQUIVO');
});

test('conta genérica no arquivo usa último escrevente que movimentou antes, mesmo em outra etapa', () => {
  const p = anterior(pedido()), r = decidir(p);
  assert.equal(r.evidencia.metodo, A.METODO_ANTERIOR); assert.deepEqual(r.colaborador, pessoa(1));
  assert.deepEqual(r.evidencia.decisao.marco_arquivo.acoes_ids, [id(105)]);
  assert.deepEqual(r.evidencia.decisao.movimentacao_escrevente.acoes_ids, [id(104)]);
  assert.equal(r.evidencia.decisao.marco_arquivo.ator_trello_id, id(99));
  assert.equal(r.evidencia.decisao.movimentacao_escrevente.ator_trello_id, id(1));
  assert.equal(r.evidencia.decisao.origem_ator, 'ultima_movimentacao_escrevente_anterior');
  p.evidencia.trello.movimentacoes[2].criador = { id: id(98), nome: 'Recepção Fictícia', username: 'recepcao', tipo: 'humano' };
  assert.equal(decidir(p).evidencia.metodo, A.METODO_ANTERIOR);
  p.evidencia.trello.movimentacoes[2].automacao = true;
  assert.equal(decidir(p).colaborador.id, 'pessoa.1'); // nunca credita o robô do arquivo
  p.evidencia.trello.movimentacoes[1].quadro_id = null;
  assert.equal(S.preverAutoriaArquivo(p, registro(1), cadastro).colaborador.id, 'pessoa.1');
});

test('não salta pessoa desconhecida posterior ao escrevente e não inventa ordem em empate', () => {
  const p = anterior(pedido());
  p.evidencia.trello.movimentacoes.push(movimento(108, { id: id(20), nome: 'Pessoa desconhecida', tipo: 'humano' }, '2026-09-04T12:00:00-03:00', id(901), id(902)));
  pendente(() => decidir(p), 'MOVIMENTADOR_INTERMEDIARIO_NAO_IDENTIFICADO');
  p.evidencia.trello.movimentacoes.pop();
  p.evidencia.trello.movimentacoes.push(movimento(108, ator(2), '2026-09-04T10:00:00-03:00', id(901), id(902)));
  pendente(() => decidir(p), 'ULTIMA_MOVIMENTACAO_AMBIGUA');
  p.evidencia.trello.movimentacoes.at(-1).criador = ator(1);
  assert.equal(decidir(p).colaborador.id, 'pessoa.1');
  p.evidencia.trello.movimentacoes.at(-1).date = '2026-09-05T09:00:00-03:00';
  pendente(() => decidir(p), 'ORDEM_MOVIMENTACOES_AMBIGUA');
});

test('moveCardToBoard sem origem pode comprovar chegada; destino omitido permanece desconhecido', () => {
  const p = pedido(), x = p.evidencia.trello.movimentacoes[0];
  x.type = 'moveCardToBoard'; delete x.listBefore;
  let r = decidir(p); assert.equal(r.colaborador.id, 'pessoa.1'); assert.equal(r.evidencia.trello.movimentacoes[0].quadro_antes, null);
  x.quadro_antes = A.QUADRO; assert.throws(() => decidir(p), e => e.status === 400); delete x.quadro_antes;
  delete x.listAfter;
  r = decidir(p); assert.equal(r.evidencia.metodo, A.METODO_ANTERIOR);
  assert.equal(r.evidencia.decisao.marco_arquivo.tipo, 'primeira_constatacao_arquivo');
  assert.equal(r.evidencia.decisao.janela_entrada_indeterminada.destino_transferencia, null);
  p.evidencia.trello.movimentacoes.pop(); // sem a prova posterior de estado arquivado
  pendente(() => decidir(p), 'SEM_ENTRADA_COMPROVADA_NO_ARQUIVO');
  assert.equal(S.validarAutoria(p).evidencia.trello.movimentacoes[0].listAfter, null);
});

test('primeira constatação de arquivo preserva janela desconhecida e não credita organização', () => {
  const p = anterior(pedido()), eventos = p.evidencia.trello.movimentacoes;
  eventos[2].type = 'moveCardToBoard'; delete eventos[2].listBefore; delete eventos[2].listAfter; delete eventos[2].quadro_id;
  let r = decidir(p); assert.deepEqual(r.colaborador, pessoa(1));
  assert.equal(r.evidencia.metodo, A.METODO_ANTERIOR);
  assert.equal(r.evidencia.decisao.marco_arquivo.tipo, 'primeira_constatacao_arquivo');
  assert.deepEqual(r.evidencia.decisao.marco_arquivo.acoes_ids, [id(106)]);
  assert.equal(r.evidencia.decisao.janela_entrada_indeterminada.transferencia_acao_id, id(105));
  assert.equal(r.evidencia.trello.movimentacoes[2].quadro_id, null);
  eventos.push(movimento(107, ator(2), '2026-09-05T12:00:00-03:00', id(901), id(902)));
  pendente(() => decidir(p), 'MOVIMENTO_INDIVIDUAL_NA_JANELA_INDETERMINADA');
  eventos.pop(); eventos[3].criador = ator(2); // reorganizador posterior não recebe o crédito
  r = decidir(p); assert.equal(r.colaborador.id, 'pessoa.1');
  eventos.push({ ...clone(eventos[2]), id: id(108), date: '2026-09-07T12:00:00-03:00' });
  pendente(() => decidir(p), 'ENTRADA_POSTERIOR_NAO_DETERMINADA');
});

test('somente fontes íntegras, vínculos únicos e pessoas inequívocas permitem crédito', () => {
  const cenarios = [
    [p => p.evidencia.trello.historico_completo_ate_corte = false, 'HISTORICO_TRELLO_INCOMPLETO'],
    [p => p.evidencia.vinculo.confirmado_unico = false, 'VINCULO_ATO_CARTAO_NAO_UNICO'],
    [p => p.evidencia.trello.movimentacoes[0].criador.tipo = 'bot', 'SEM_ESCREVENTE_ANTERIOR_AO_ARQUIVO'],
    [p => p.evidencia.trello.movimentacoes[0].automacao = true, 'SEM_ESCREVENTE_ANTERIOR_AO_ARQUIVO'],
    [p => p.evidencia.trello.movimentacoes[0].appCreator = { id: id(44) }, 'SEM_ESCREVENTE_ANTERIOR_AO_ARQUIVO'],
    [p => p.evidencia.trello.movimentacoes[0].criador = { id: id(20), nome: 'Sem cadastro', tipo: 'humano' }, 'ATOR_ARQUIVO_NAO_IDENTIFICADO'],
    [p => p.evidencia.trello.movimentacoes[0].criador.colaborador_hub = pessoa(2), 'ATOR_TRELLO_COLABORADOR_DIVERGENTE']
  ];
  for (const [editar, codigo] of cenarios) { const p = pedido(); editar(p); pendente(() => decidir(p), codigo); }
  const aliases = clone(cadastro); aliases[0].aliases = ['Nome social sintético'];
  const p = pedido(); p.evidencia.trello.movimentacoes[0].criador.nome = 'Nome social sintético'; delete p.evidencia.trello.movimentacoes[0].criador.username;
  assert.deepEqual(decidir(p, aliases).colaborador, pessoa(1));
  aliases.push({ login: 'duplicado', nome: 'Nome social sintético', escrevente: true });
  pendente(() => decidir(p, aliases), 'ATOR_ARQUIVO_NAO_IDENTIFICADO');
});

test('perfil documentado vincula nome completo ao login Hub sem adivinhar nomes curtos duplicados', () => {
  const p = pedido(), c = p.evidencia.trello.movimentacoes[0].criador;
  c.nome = 'Nome completo da pessoa na fonte'; c.username = 'username_na_fonte'; delete c.colaborador_hub;
  const pessoas = [{ login: 'pessoa.1', nome: 'Nome Curto', escrevente: true }, { login: 'pessoa.2', nome: 'Nome Curto', escrevente: true }];
  pendente(() => decidir(p, pessoas), 'ATOR_ARQUIVO_NAO_IDENTIFICADO');
  c.identidade_conferida = { trello_id: c.id, login_hub: 'pessoa.2', referencia: 'Perfil oficial e configuração documental sintéticos', sha256: 'f'.repeat(64), coletado_em: '2026-10-12T17:00:00-03:00' };
  const r = decidir(p, pessoas); assert.deepEqual(r.colaborador, { id: 'pessoa.2', nome: 'Nome Curto' });
  assert.equal(r.evidencia.decisao.criterio_identidade, 'vinculo_documental_trello_login_hub');
  assert.equal(r.evidencia.trello.movimentacoes[0].criador.nome, 'Nome completo da pessoa na fonte');
  c.identidade_conferida.trello_id = id(2); assert.throws(() => decidir(p, pessoas), e => e.status === 400);
  c.identidade_conferida.trello_id = c.id; c.identidade_conferida.coletado_em = '2099-10-12T17:00:00Z';
  assert.throws(() => decidir(p, pessoas), e => e.codigo === 'EVIDENCIA_TEMPORAL_INVALIDA');
});

test('validação não aceita ato/cartão/lista trocados, dados futuros ou decisão enviada pronta', () => {
  for (const editar of [p => p.evidencia.vinculo.ato.minuta = 'outro', p => p.evidencia.vinculo.cartao_id = id(600),
    p => p.evidencia.trello.movimentacoes[0].cartao_id = id(600), p => p.evidencia.trello.listas_arquivo[0].id = id(999),
    p => p.evidencia.trello.movimentacoes.push(clone(p.evidencia.trello.movimentacoes[0])), p => p.evidencia.trello.quadro.id = id(600),
    p => p.evidencia.metodo = A.METODO, p => p.colaborador = pessoa(2), p => p.evidencia.trello.movimentacoes[0].type = 'commentCard']) {
    const p = pedido(); editar(p); assert.throws(() => decidir(p), e => e.status === 400);
  }
  const p = pedido(); for (const f of [p.evidencia.ato, p.evidencia.vinculo.ato, p.evidencia.trello.ato]) f.folha = '99';
  assert.throws(() => decidir(p), e => e.codigo === 'IDENTIDADE_DIVERGENTE');
  const temporal = pedido(); temporal.evidencia.trello.coletado_em = '2099-10-12T17:05:00-03:00';
  assert.throws(() => decidir(temporal), e => e.codigo === 'EVIDENCIA_TEMPORAL_INVALIDA');
});

test('PostgreSQL: novo critério conserva atos/financeiro, CAS, idempotência, histórico e migração repetível', { skip: !process.env.ATOS_TEST_DATABASE_URL }, async t => {
  const url = process.env.ATOS_TEST_DATABASE_URL, admin = new Pool({ connectionString: url, max: 1 });
  const schema = 'arquivo_test_' + randomUUID().replace(/-/g, ''); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await pool.query(`CREATE TABLE usuarios(login text PRIMARY KEY,nome text,cargo text);
    CREATE TABLE escreventes(login text PRIMARY KEY,nome text,ativo boolean);
    INSERT INTO usuarios VALUES('pessoa.1','Escrevente 1','Escrevente'),('pessoa.2','Escrevente 2','Escrevente'),('recepcao','Recepção Fictícia','Recepção');
    INSERT INTO escreventes VALUES('pessoa.1','Escrevente 1',true),('pessoa.2','Escrevente 2',false);
    CREATE TABLE produtividade_mes(dados jsonb); INSERT INTO produtividade_mes VALUES('{"total":12345.67,"atos":900}');`);
  await S.importar(pool, { operacao_id: randomUUID(), fonte: { sistema: 'Extra Digital', arquivo: 'sintetico.csv', sha256: 'd'.repeat(64) },
    meses: [{ mes: '2026-09', ate: '2026-09-30', revisao_base: 0, corte_em: '2026-10-12T17:00:00-03:00', dia_final_completo: true }], registros: [1, 2, 3, 4, 5].map(registro) }, 'admin.fixture');
  const keys = Object.fromEntries((await S.atos(pool, '2026-09-01', '2026-09-30')).itens.map(x => [x.registro.minuta, x.chave]));
  const originals = (await pool.query('SELECT row_to_json(t)::text AS linha FROM atos_lavrados_itens t ORDER BY chave')).rows;
  const financeiro = (await pool.query('SELECT dados FROM produtividade_mes')).rows;
  const app = express(); app.use('/hub/atos-lavrados', createRouter({ pool, session: async token => token ? { login: token } : null, ehAdmin: u => u.login === 'admin.fixture' }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const post = (p, token = 'admin.fixture') => fetch(`http://127.0.0.1:${server.address().port}/hub/atos-lavrados/autorias`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Auth-Token': token } : {}) }, body: JSON.stringify(p) });
  await t.test('401/403; mesma evidência concorrente confirma uma versão só e permite repetir', async () => {
    const p = pedido(1, keys[1]); assert.equal((await post(p, '')).status, 401); assert.equal((await post(p, 'nao.admin')).status, 403);
    const res = await Promise.all([post(p), post(p)]); assert.deepEqual(res.map(x => x.status), [200, 200]);
    const js = await Promise.all(res.map(x => x.json())); assert.equal(js.filter(x => x.repetida).length, 1);
    assert.equal((await S.historicoAutoria(pool, keys[1])).length, 1); assert.ok(js.every(x => x.revisao === 1));
  });
  await t.test('método anterior guarda as duas ações, contagens e vínculo sem exigir protocolo Hub', async () => {
    const p = anterior(pedido(2, keys[2])); assert.equal((await post(p)).status, 200);
    const r = await S.resumo(pool, '2026-09-01', '2026-09-30', true);
    assert.equal(r.autoria.metodos.movimentacao_arquivo_trello, 1); assert.equal(r.autoria.metodos.ultimo_escrevente_antes_arquivo_trello, 1);
    assert.equal(r.autoria.com_cartao_trello, 2); assert.equal(r.com_vinculo, 0); assert.equal(r.total_oficial, 5);
    assert.equal(r.autoria.sem_autoria_confirmada, 3); assert.equal(r.colaboradores[0].total_observado, 2);
    assert.equal(Object.values(r.colaboradores[0].metodos).reduce((a, b) => a + b, 0), 2);
    assert.doesNotMatch(JSON.stringify(r), /fonte sintética|marco_arquivo|sha256_calculado/);
    const items = (await S.atos(pool, '2026-09-01', '2026-09-30')).itens;
    assert.equal(items.find(x => x.chave === keys[2]).vinculo_trello.cartao_id, id(500));
    assert.equal(items.find(x => x.chave === keys[3]).vinculo_trello, null);
    const h = await S.historicoAutoria(pool, keys[2]); assert.equal(h[0].evidencia.decisao.marco_arquivo.acoes_ids[0], id(105));
    assert.equal(h[0].evidencia.decisao.movimentacao_escrevente.acoes_ids[0], id(104));
  });
  await t.test('direta tem prioridade; fontes diferentes concorrentes não sobrescrevem', async () => {
    const direta = { chave: keys[3], revisao_base: 0, colaborador: pessoa(2), evidencia: { tipo: 'registro_lavratura_extra', marco: 'registro', referencia: 'fonte direta sintética', campo_ou_evento: 'Responsável pelo registro', valor_original: 'pessoa.2' } };
    assert.equal((await post(direta)).status, 200);
    const r = await post(pedido(3, keys[3], 1)); assert.equal(r.status, 409); assert.equal((await r.json()).codigo, 'AUTORIA_DIRETA_PRIORITARIA');
    const a = pedido(4, keys[4]), b = clone(a); b.evidencia.trello.movimentacoes[0].criador = ator(2);
    assert.deepEqual((await Promise.all([post(a), post(b)])).map(x => x.status).sort(), [200, 409]);
  });
  await t.test('pendência e corte antigo não apagam dados; reinicialização aceita evidência já salva', async () => {
    const before = await S.historicoAutoria(pool, keys[1]), p = pedido(1, keys[1], 1); p.evidencia.vinculo.confirmado_unico = false;
    const res = await post(p); assert.equal(res.status, 422); assert.equal(res.headers.get('cache-control'), 'private, no-store');
    p.evidencia.vinculo.confirmado_unico = true; p.evidencia.corte_em = '2026-10-11T17:00:00-03:00';
    assert.equal((await post(p)).status, 409); assert.deepEqual(await S.historicoAutoria(pool, keys[1]), before);
    const outroPool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 1 });
    try { await S.init(outroPool); assert.equal((await S.resumo(outroPool, '2026-09-01', '2026-09-30', true)).autoria.com_autoria_confirmada, 4); }
    finally { await outroPool.end(); }
    await assert.rejects(pool.query("UPDATE atos_lavrados_autorias SET marco='registro' WHERE minuta='1'"), e => e.code === '23514');
    assert.deepEqual((await pool.query('SELECT row_to_json(t)::text AS linha FROM atos_lavrados_itens t ORDER BY chave')).rows, originals);
    assert.deepEqual((await pool.query('SELECT dados FROM produtividade_mes')).rows, financeiro);
  });
  await t.test('rotina antiga não repõe critério CTN sobre arquivo sem revogação explícita', async () => {
    const base = pedido(5, keys[5]), fonte = { referencia: 'fonte sintética antiga', sha256: 'b'.repeat(64), coletado_em: '2026-10-12T19:00:00-03:00', ato: clone(base.evidencia.ato) };
    const antigo = { chave: keys[5], revisao_base: 0, evidencia: { tipo: 'auditoria_trello_criterio_titular', marco: 'atribuicao_gerencial', corte_em: '2026-10-12T16:00:00-03:00', ato: clone(base.evidencia.ato),
      auditoria: { ...clone(fonte), completa_ate_corte: true, eventos: [{ id: 'evento-antigo-fixture', em: '2026-09-01T10:00:00-03:00', acao: 'alteracao_minuta', usuario_original: 'pessoa.2', colaborador: pessoa(2) }] },
      trello: { ...clone(fonte), cartao_id: id(500), campo_responsavel: 'Responsável', responsaveis: [{ valor_original: 'pessoa.2', colaborador: pessoa(2) }] } } };
    assert.equal((await post(antigo)).status, 200);
    base.revisao_base = 1; assert.equal((await post(base)).status, 200);
    antigo.revisao_base = 2; antigo.evidencia.corte_em = '2026-10-12T18:00:00-03:00';
    const r = await post(antigo); assert.equal(r.status, 409); assert.equal((await r.json()).codigo, 'CRITERIO_GERENCIAL_SUPERADO');
    assert.equal((await S.historicoAutoria(pool, keys[5])).length, 2);
    assert.equal((await post({ chave: keys[5], revisao_base: 2, revogar: true, motivo: 'Retificação documental sintética explícita' })).status, 200);
    antigo.revisao_base = 3; assert.equal((await post(antigo)).status, 200);
    assert.equal((await S.historicoAutoria(pool, keys[5])).length, 4);
  });
});
