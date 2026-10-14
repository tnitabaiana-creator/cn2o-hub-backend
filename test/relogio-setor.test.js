'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../relogio-setor');
const P = require('../protocolo-cadastro');
const cal = require('../horas-uteis');
const ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const H = s => new Date(s + ':00-03:00');
const inicio = H('2026-09-21T09:00'), agora = H('2026-09-21T11:00');
const card0 = () => ({ id: ID, idBoard: P.BOARDS.protocolo, idList: P.LISTAS.digitalizacao,
  closed: false, due: '2030-01-01T00:00:00Z', dueComplete: false,
  cover: { size: 'full', color: 'purple', idAttachment: null }, customFieldItems: [] });
const ev = (id, data, tipo, dados) => ({ action_id: id, card_id: ID, ocorrido_em: data, tipo,
  dados: { card: { id: ID, name: 'Prot. (CV) 1234', shortLink: 'AbCdEfGh' }, ...dados } });
const entrada = () => ev('entrada', inicio, 'updateCard', { board: { id: P.BOARDS.protocolo },
  listBefore: { id: 'entrada' }, listAfter: { id: P.LISTAS.digitalizacao } });
const entrega = () => ev('entrega', H('2026-09-21T10:30'), 'moveCardToBoard',
  { board: { id: P.BOARDS.tabeliao }, boardSource: { id: P.BOARDS.protocolo }, list: { id: P.LISTAS.gerar_minuta } });

test('relógio usa 8h úteis e prazo próprio; retorno interno não reinicia', () => {
  const eventos = [entrada(), ev('cad', H('2026-09-21T10:00'), 'updateCard', {
    board: { id: P.BOARDS.protocolo }, listBefore: { id: P.LISTAS.digitalizacao }, listAfter: { id: P.LISTAS.cadastro } }),
  ev('volta', H('2026-09-21T10:30'), 'updateCard', { board: { id: P.BOARDS.protocolo },
    listBefore: { id: P.LISTAS.cadastro }, listAfter: { id: P.LISTAS.digitalizacao } })];
  const p = R.projetar(eventos, card0(), agora);
  assert.equal(p.prazo, H('2026-09-22T09:00').toISOString());
  assert.match(p.texto, /06h00 restantes/); assert.equal(p.ativo, true);
  assert.equal(p.detalhes.ciclo.retornos, 1);
  const almoco = R.projetar(eventos, card0(), H('2026-09-21T12:50'));
  assert.match(almoco.texto, /05h00 restantes/);
});

test('conclusão congela em Gerar desde Digitalização e sinaliza Cadastro ausente', () => {
  const card = { ...card0(), idBoard: P.BOARDS.tabeliao, idList: 'auditoria' };
  const p = R.projetar([entrada(), entrega()], card, H('2026-10-01T16:00'));
  assert.equal(p.estado, 'concluido'); assert.equal(p.ativo, false);
  assert.match(p.texto, /01h30 concluído · s\/ Cadastro · 21\/09 10:30/);
  assert.equal(p.detalhes.horas_uteis, 1.5);
  assert.equal(R.projetar([entrada(), entrega()], { ...card, closed: true }, agora).texto,
    R.projetar([entrada(), entrega()], card, agora).texto);
  assert.equal(R.projetar([entrada(), entrega()], card0(), agora).estado, 'pendente');
});

test('sem entrada, prazo e duração permanecem ausentes; excesso não avança fora do expediente', () => {
  const unknown = R.projetar([], card0(), agora);
  assert.equal(unknown.prazo, null); assert.match(unknown.texto, /Entrada não localizada/);
  const done = R.projetar([entrega()], { ...card0(), idBoard: P.BOARDS.tabeliao }, agora);
  assert.equal(done.estado, 'concluido_sem_inicio'); assert.equal(done.prazo, null);
  const tarde = R.projetar([entrada()], card0(), H('2026-09-22T19:00'));
  const noite = R.projetar([entrada()], card0(), H('2026-09-23T07:00'));
  assert.match(tarde.texto, /07h00 excedido/);
  assert.equal(tarde.detalhes.horas_uteis, noite.detalhes.horas_uteis);
});

function harness({ eventos = [entrada()], falharPut = false, lock = true, movimento = false } = {}) {
  const state = { card: card0(), eventos, calls: [], sql: [], saved: null, cover: null, puts: 0, released: false, metricas: [] };
  const fields = Object.fromEntries(R.QUADROS.map((q, b) => [q, R.CAMPOS.map((c, i) =>
    ({ ...c, id: `field${b}${i}`, display: { cardFront: true } }))]));
  const query = async (sql, params) => {
    state.sql.push({ sql, params });
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: lock }] };
    if (sql.includes('FROM eventos_trello') && sql.includes('WHERE card_id=$1')) return { rows: structuredClone(state.eventos) };
    if (sql.startsWith('SELECT * FROM prazos_metricas')) {
      return { rows: structuredClone(state.metricas.filter(m => m.tipo === 'setor' &&
        m.card_id === params[0] && m.evidencia === params[1])) };
    }
    if (sql.startsWith('INSERT INTO prazos_metricas') && sql.includes('RETURNING *')) {
      if (state.metricas.some(m => m.chave === params[0])) return { rows: [] };
      const colunas = ['chave', 'card_id', 'protocolo', 'responsavel_login', 'ato', 'inicio',
        'vencimento', 'concluido_em', 'no_prazo', 'horas_uteis', 'atraso_horas_uteis', 'evidencia'];
      const row = { tipo: 'setor', ...Object.fromEntries(colunas.map((c, i) => [c, params[i]])) };
      state.metricas.push(row);
      return { rows: [structuredClone(row)] };
    }
    if (sql.startsWith('UPDATE prazos_metricas SET')) {
      const rows = state.metricas.filter(m => m.tipo === 'setor' && m.card_id === params[1] && m.evidencia === params[2]);
      if (rows.length !== 1 || rows[0].chave !== params[0]) return { rows: [] };
      Object.assign(rows[0], { inicio: params[3], vencimento: params[4], no_prazo: params[5],
        horas_uteis: params[6], atraso_horas_uteis: params[7] });
      return { rows: structuredClone(rows) };
    }
    if (sql.includes('cover_original) VALUES')) state.cover = JSON.parse(params[1]);
    if (sql.includes('(card_id,board_id,list_id,ciclo_id')) state.saved = params;
    return { rows: [] };
  };
  const api = async (method, path, body) => {
    state.calls.push({ method, path, body });
    const board = path.match(/^\/boards\/([^/]+)\/customFields$/);
    if (board) return structuredClone(fields[board[1]]);
    if (method === 'GET' && path.startsWith('/lists/')) return [];
    if (method === 'GET' && path.startsWith('/cards/')) return structuredClone(state.card);
    if (method === 'PUT' && path === `/cards/${ID}`) { Object.assign(state.card.cover, body.cover); return {}; }
    const cf = path.match(/\/customField\/([^/]+)\/item$/);
    if (method === 'PUT' && cf) {
      state.puts++;
      state.card.customFieldItems = state.card.customFieldItems.filter(x => x.idCustomField !== cf[1]);
      if (body.value) state.card.customFieldItems.push({ idCustomField: cf[1], value: body.value });
      if (movimento && state.puts === 1) {
        state.eventos.push(entrega()); state.card.idBoard = P.BOARDS.tabeliao; state.card.idList = P.LISTAS.gerar_minuta;
      }
      if (falharPut && state.puts === 1) throw Object.assign(new Error('uncertain'), { codigo: 'trello_timeout', interromper: true });
      return {};
    }
    throw Error('mock path inesperado ' + method + ' ' + path);
  };
  const pool = { query, connect: async () => ({ query, release: () => { state.released = true; } }) };
  const svc = R.criarServico({ pool, api, agora: () => agora, habilitado: () => true, log: () => {} });
  return { state, svc, fields, api, pool };
}

test('sincronização conserva due e capa, salva original antes da alteração e confirma campos', async () => {
  const { state, svc } = harness();
  const r = await svc.executar({ cardId: ID });
  assert.equal(r.confirmados, 1); assert.equal(r.erros, 0);
  assert.equal(state.card.due, '2030-01-01T00:00:00Z'); assert.equal(state.card.dueComplete, false);
  assert.equal(state.card.cover.size, 'normal'); assert.equal(state.card.cover.color, 'purple');
  assert.equal(state.cover.size, 'full'); assert.equal(state.saved[4], 'em_andamento');
  assert.ok(state.saved[10]); assert.ok(state.released);
  for (const c of state.calls.filter(x => x.method === 'PUT')) {
    assert.deepEqual(Object.keys(c.body), c.path.includes('customField') ? ['value'] : ['cover']);
  }
});

test('PUT de resultado incerto é confirmado por GET sem repetição', async () => {
  const { state, svc } = harness({ falharPut: true });
  const r = await svc.executar({ cardId: ID });
  assert.equal(r.confirmados, 1); assert.equal(r.erros, 0); assert.equal(state.puts, 2);
});

test('movimentação concorrente não confirma projeção velha e reconstrói entrega', async () => {
  const { state, svc } = harness({ movimento: true });
  const r = await svc.executar({ cardId: ID });
  assert.equal(r.confirmados, 1); assert.equal(state.saved[4], 'concluido');
  assert.equal(state.saved[5], false); assert.match(state.saved[7], /01h30 concluído/);
});

test('trava ocupada e feature flag impedem qualquer escrita Trello', async () => {
  const { state, svc } = harness({ lock: false });
  assert.deepEqual(await svc.executar({ cardId: ID }), { ocupado: true });
  assert.equal(state.calls.length, 0); assert.equal(state.released, true);
  const disabled = R.criarServico({ habilitado: () => false, api: async () => assert.fail('API chamada') });
  assert.equal((await disabled.executar()).ativo, false);
});

test('provisionamento reconcilia POST incerto, não duplica e rejeita tipo conflitante', async () => {
  const defs = []; let posts = 0;
  const api = async (method, path, body) => {
    if (method === 'GET') return structuredClone(defs);
    if (method === 'POST') {
      posts++; defs.push({ ...body, id: 'd' + posts, display: { cardFront: true } });
      throw Object.assign(new Error('lost'), { codigo: 'trello_timeout' });
    }
    assert.fail('escrita inesperada');
  };
  const svc = R.criarServico({ api });
  const fields = await svc.provisionar(P.BOARDS.protocolo);
  assert.equal(fields.date, 'd1'); assert.equal(fields.text, 'd2');
  await svc.provisionar(P.BOARDS.protocolo); assert.equal(posts, 2);
  defs[0].type = 'number'; await assert.rejects(svc.provisionar(P.BOARDS.protocolo), /campo_tipo_incompativel/);
  await assert.rejects(svc.provisionar('outro'), /quadro_fora_escopo/);
});

test('API normaliza credenciais e nunca propaga URL, corpo ou segredo de falha', async () => {
  const api = R.criarApi({ env: { TRELLO_KEY: ' chave\n', TRELLO_TOKEN: ' segredo\n' },
    fetchFn: async url => {
      assert.equal(new URL(url).searchParams.get('token'), 'segredo');
      throw new Error(url);
    } });
  await assert.rejects(api('GET', '/cards/123'), e => e.message === 'trello_rede_ou_resposta' && !e.message.includes('segredo'));
  const denied = R.criarApi({ env: { TRELLO_KEY: 'x', TRELLO_TOKEN: 'y' }, fetchFn: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(denied('GET', '/cards/123'), e => e.interromper === true && e.status === 429);
});

test('cartão arquivado ou no Arquivo Geral nunca recebe escrita de capa ou campos', async () => {
  for (const patch of [{ closed: true }, { idList: '69344a6fc5e00099568028f9' }]) {
    const { state, svc } = harness({ eventos: [entrada(), entrega()] });
    Object.assign(state.card, patch);
    const r = await svc.executar({ cardId: ID });
    assert.equal(r.ignorados, 1); assert.equal(r.confirmados, 0);
    assert.equal(state.calls.filter(c => c.method !== 'GET').length, 0);
  }
});

test('beforeSweep executa sob lock e não faz importação em execução direcionada', async () => {
  const { pool, api } = harness(); let sweeps = 0, refreshes = 0;
  const svc = R.criarServico({ pool, api, habilitado: () => true, agora: () => agora,
    beforeSweep: async () => { sweeps++; }, refreshHistory: async () => { refreshes++; } });
  await svc.executar({ cardId: ID });
  assert.equal(sweeps, 0); assert.equal(refreshes, 1);
  await svc.executar({ cardIds: [], varrer: true });
  assert.equal(sweeps, 1);
});

test('404 preserva pendência sem repetir cartão inacessível indefinidamente', async () => {
  const { pool, api, state } = harness();
  const svc = R.criarServico({ pool, habilitado: () => true, agora: () => agora,
    api: async (method, path, body) => {
      if (path.startsWith('/cards/')) throw Object.assign(new Error('não acessível'), { codigo: 'trello_http_404', status: 404 });
      return api(method, path, body);
    } });
  const r = await svc.executar({ cardId: ID });
  assert.equal(r.erros, 1);
  const registro = state.sql.find(q => q.sql.includes("estado='inacessivel'"));
  assert.ok(registro); assert.match(registro.sql, /ativo=false,precisa_repetir=false/);
  assert.equal(state.calls.filter(c => c.method !== 'GET').length, 0);
});


test('entrada em Digitalização inicia imediatamente 8h úteis, antes de qualquer Cadastro', () => {
  const r = R.projetar([entrada()], card0(), inicio);
  assert.equal(r.estado, 'em_andamento');
  assert.equal(r.ativo, true);
  assert.equal(r.detalhes.horas_uteis, 0);
  assert.equal(r.detalhes.inicio, inicio.toISOString());
  assert.equal(r.detalhes.marco_inicial, 'digitalizacao');
  assert.equal(r.prazo, H('2026-09-22T09:00').toISOString());
  assert.match(r.texto, /🟢 08h00 restantes/);
  assert.equal(r.detalhes.ciclo.cadastro_confirmado, false);
});

test('Cadastro posterior mantém início e prazo setoriais da Digitalização', () => {
  const cadastro = ev('cadastro', H('2026-09-21T10:00'), 'updateCard', {
    board: { id: P.BOARDS.protocolo }, listBefore: { id: P.LISTAS.digitalizacao },
    listAfter: { id: P.LISTAS.cadastro } });
  const semCadastro = R.projetar([entrada()], card0(), agora);
  const r = R.projetar([entrada(), cadastro], { ...card0(), idList: P.LISTAS.cadastro }, agora);
  assert.equal(r.estado, 'em_andamento');
  assert.equal(r.detalhes.horas_uteis, 2);
  assert.equal(r.detalhes.inicio, inicio.toISOString());
  assert.equal(r.ciclo_id, semCadastro.ciclo_id);
  assert.equal(r.prazo, semCadastro.prazo);
  assert.match(r.texto, /🟢 06h00 restantes/);
});

test('Cadastro sem entrada comprovada em Digitalização mantém duração pendente', () => {
  const cadastro = ev('cadastro', H('2026-09-21T10:00'), 'updateCard', {
    board: { id: P.BOARDS.protocolo }, listBefore: { id: 'entrada' },
    listAfter: { id: P.LISTAS.cadastro } });
  const r = R.projetar([cadastro], { ...card0(), idList: P.LISTAS.cadastro }, agora);
  assert.equal(r.estado, 'pendente');
  assert.equal(r.ativo, true);
  assert.equal(r.prazo, null);
  assert.equal(r.detalhes.horas_uteis, undefined);
  assert.match(r.texto, /Entrada não localizada/);
});

test('entrega após Cadastro congela toda a duração desde Digitalização, sem ressalva', () => {
  const cadastro = ev('cadastro', H('2026-09-21T10:00'), 'updateCard', {
    board: { id: P.BOARDS.protocolo }, listBefore: { id: P.LISTAS.digitalizacao },
    listAfter: { id: P.LISTAS.cadastro } });
  const saida = ev('saida', H('2026-09-21T10:30'), 'moveCardFromBoard', {
    board: { id: P.BOARDS.protocolo }, boardTarget: { id: P.BOARDS.tabeliao },
    list: { id: P.LISTAS.cadastro } });
  const r = R.projetar([entrada(), cadastro, saida, entrega()],
    { ...card0(), idBoard: P.BOARDS.tabeliao, idList: P.LISTAS.gerar_minuta }, agora);
  assert.equal(r.estado, 'concluido');
  assert.equal(r.ativo, false);
  assert.equal(r.detalhes.horas_uteis, 1.5);
  assert.equal(r.detalhes.inicio, inicio.toISOString());
  assert.equal(r.detalhes.ciclo.cadastro_confirmado, true);
  assert.match(r.texto, /01h30 concluído · 21\/09 10:30/);
  assert.doesNotMatch(r.texto, /s\/ Cadastro/);
});
