'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { criarColetor } = require('../relogio-setor-integracao');
const P = require('../protocolo-cadastro');
const R = require('../rastreio');
const CARD = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OUTRO_CARD = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const NOW = new Date('2026-10-14T14:15:00.000Z');
const action = n => ({ id: n.toString(16).padStart(24, '0'), date: '2026-10-13T14:00:00.000Z',
  type: 'updateCard', data: { card: { id: CARD }, board: { id: P.BOARDS.protocolo },
    listBefore: { id: 'cccccccccccccccccccccccc' }, listAfter: { id: P.LISTAS.digitalizacao } } });

function ambiente(paginas) {
  const calls = [], registros = [], queries = [];
  const coletor = criarColetor({ agora: () => new Date(NOW), api: async (...args) => {
    calls.push(args);
    const resposta = typeof paginas === 'function' ? await paginas(args, calls.length) : paginas[calls.length - 1];
    if (resposta instanceof Error) throw resposta;
    return resposta;
  }, registrar: async (acoes, origem) => {
    registros.push({ acoes, origem }); return acoes.length;
  }, pool: { query: async (...args) => { queries.push(args); return { rows: [] }; } } });
  return { coletor, calls, registros, queries };
}

test('coletor pagina pelo último ID e só registra após completar a leitura', async () => {
  const primeira = Array.from({ length: 1000 }, (_, i) => action(i + 1));
  const h = ambiente([primeira, [primeira[999], action(1001)]]);
  const r = await h.coletor.refreshHistory(CARD);
  assert.deepEqual(r, { quantidade: 1001, novos: 1001 });
  assert.equal(h.calls.length, 2);
  const url = new URL(h.calls[1][1], 'https://exemplo.invalid');
  assert.equal(url.pathname, `/cards/${CARD}/actions`);
  assert.equal(url.searchParams.get('before'), primeira[999].id);
  assert.equal(url.searchParams.get('limit'), '1000');
  assert.equal(url.searchParams.get('filter'), R.FILTRO_API);
  assert.equal(h.registros.length, 1);
  assert.equal(h.registros[0].acoes.length, 1001);
  assert.equal(h.registros[0].origem, 'carga_setorial');
  const recibo = h.queries.find(([sql]) => sql.startsWith('INSERT INTO relogio_setor_coletas'));
  assert.equal(recibo[1][0], `/cards/${CARD}/actions`);
  assert.equal(recibo[1][3], 1001);
  assert.equal(recibo[1][5], crypto.createHash('sha256').update(JSON.stringify([...primeira, action(1001)])).digest('hex'));
  assert.ok(h.queries.every(([sql]) => !/DELETE|UPDATE (?:protocolos|conclusoes|passagens|pendencias)/.test(sql)));
});

test('coletor não publica fotografia parcial quando a segunda página falha', async () => {
  const h = ambiente([Array.from({ length: 1000 }, (_, i) => action(i + 1)), new Error('API indisponível')]);
  await assert.rejects(h.coletor.refreshHistory(CARD), /API indisponível/);
  assert.equal(h.registros.length, 0);
  assert.equal(h.queries.length, 0);
});

test('coletor rejeita paginação que repete o cursor sem gravar lote incompleto', async () => {
  const pagina = Array.from({ length: 1000 }, (_, i) => action(i + 1));
  const h = ambiente([pagina, pagina]);
  await assert.rejects(h.coletor.refreshHistory(CARD), /historico_incompleto/);
  assert.equal(h.calls.length, 2);
  assert.equal(h.registros.length, 0);
  assert.equal(h.queries.length, 0);
});

test('coletor rejeita limite de vinte páginas cheias sem inferir cobertura', async () => {
  const h = ambiente((_args, num) => Array.from({ length: 1000 }, (_, i) => action((num - 1) * 1000 + i + 1)));
  await assert.rejects(h.coletor.refreshHistory(CARD), /historico_incompleto/);
  assert.equal(h.calls.length, 20);
  assert.equal(h.registros.length, 0);
  assert.equal(h.queries.length, 0);
});

test('coletor rejeita resposta sem array e data inválida antes de qualquer escrita', async () => {
  for (const pagina of [{ error: 'forbidden' }, [action(1), { ...action(2), date: 'inválida' }], [action(1), null]]) {
    const h = ambiente([pagina]);
    await assert.rejects(h.coletor.refreshHistory(CARD));
    assert.equal(h.registros.length, 0);
    assert.equal(h.queries.length, 0);
  }
});

test('ações de alteração do contador não entram no histórico setorial', async () => {
  const irrelevante = { ...action(2), type: 'updateCustomFieldItem' };
  const h = ambiente([[action(1), irrelevante]]);
  assert.deepEqual(await h.coletor.refreshHistory(CARD), { quantidade: 1, novos: 1 });
  assert.deepEqual(h.registros[0].acoes, [action(1)]);
});

test('beforeSweep consulta somente os dois quadros e janela real de vinte e quatro horas', async () => {
  const h = ambiente([[], []]);
  await h.coletor.beforeSweep();
  assert.deepEqual(h.calls.map(c => new URL(c[1], 'https://exemplo.invalid').pathname),
    Object.values(P.BOARDS).map(id => `/boards/${id}/actions`));
  for (const [metodo, path] of h.calls) {
    assert.equal(metodo, 'GET');
    assert.equal(new URL(path, 'https://exemplo.invalid').searchParams.get('since'), '2026-10-13T14:15:00.000Z');
  }
  assert.ok(h.registros.every(r => r.origem === 'carga_setorial'));
});

test('beforeSweep retoma checkpoint antigo com sobreposição sem reduzir janela de quadro recente', async () => {
  const calls = [], checkpoints = [];
  const coletor = criarColetor({ agora: () => new Date(NOW),
    api: async (method, path) => { assert.equal(method, 'GET'); calls.push(path); return []; },
    registrar: async (_acoes, origem) => { assert.equal(origem, 'carga_setorial'); return 0; },
    pool: { query: async (sql, params) => {
      if (sql.startsWith('SELECT consultado_em')) {
        checkpoints.push(params[0]);
        return { rows: [{ consultado_em: params[0].includes(P.BOARDS.protocolo) ?
          '2026-10-10T10:00:00.000Z' : '2026-10-14T13:00:00.000Z' }] };
      }
      return { rows: [] };
    } } });
  await coletor.beforeSweep();
  assert.deepEqual(checkpoints, Object.values(P.BOARDS).map(id => `/boards/${id}/actions`));
  assert.equal(new URL(calls[0], 'https://exemplo.invalid').searchParams.get('since'), '2026-10-10T09:00:00.000Z');
  assert.equal(new URL(calls[1], 'https://exemplo.invalid').searchParams.get('since'), '2026-10-13T14:15:00.000Z');
});

test('beforeSweep não ignora falha de banco diferente de tabela ausente nem chama a API', async () => {
  let calls = 0, registros = 0;
  const erro = Object.assign(new Error('conexão indisponível'), { code: '08006' });
  const coletor = criarColetor({ agora: () => new Date(NOW),
    api: async () => { calls++; return []; },
    registrar: async () => { registros++; return 0; },
    pool: { query: async () => { throw erro; } } });
  await assert.rejects(coletor.beforeSweep(), e => e === erro);
  assert.equal(calls, 0); assert.equal(registros, 0);
});

test('refreshHistory recusa identificador de cartão inválido sem chamar API', async () => {
  const h = ambiente([]);
  for (const id of ['', '../boards/outro', null, 'a'.repeat(23)]) {
    await assert.rejects(h.coletor.refreshHistory(id), /card_id_invalido/);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.registros.length, 0);
});

test('coletor recusa ID de ação inválido sem registrar histórico', async () => {
  const h = ambiente([[{ ...action(1), id: 'id-malformado' }]]);
  await assert.rejects(h.coletor.refreshHistory(CARD));
  assert.equal(h.registros.length, 0);
  assert.equal(h.queries.length, 0);
});

test('coletor recusa ação relevante de outro cartão no histórico solicitado', async () => {
  const a = action(1); a.data.card.id = OUTRO_CARD;
  const h = ambiente([[a]]);
  await assert.rejects(h.coletor.refreshHistory(CARD));
  assert.equal(h.registros.length, 0);
  assert.equal(h.queries.length, 0);
});

test('coletor recusa ação relevante de outro quadro na resposta do quadro', async () => {
  const a = action(1); a.data.board.id = P.BOARDS.tabeliao;
  const h = ambiente([[a]]);
  await assert.rejects(h.coletor.coletar(`/boards/${P.BOARDS.protocolo}/actions`));
  assert.equal(h.registros.length, 0);
  assert.equal(h.queries.length, 0);
});

test('coletor recusa duplicata conflitante em vez de escolher silenciosamente a primeira', async () => {
  const a = action(1), b = action(1); b.data.listAfter.id = P.LISTAS.cadastro;
  const h = ambiente([[a, b]]);
  await assert.rejects(h.coletor.refreshHistory(CARD));
  assert.equal(h.registros.length, 0);
  assert.equal(h.queries.length, 0);
});

test('coletor recusa recursos fora do escopo antes de consultar ou gravar', async () => {
  const h = ambiente([]);
  for (const path of ['/members/me/actions', `/boards/${OUTRO_CARD}/actions`, `/cards/${CARD}/actions?filter=all`]) {
    await assert.rejects(h.coletor.coletar(path), /historico_recurso_invalido/);
  }
  assert.equal(h.calls.length, 0); assert.equal(h.registros.length, 0);
});

test('rota de estado exige administrador e devolve dados privados sem realizar sincronização', async () => {
  const express = require('express'), db = require('../db');
  const integracao = require('../relogio-setor-integracao'), relatorios = require('../relatorios');
  const originalSessao = db.sessaoValida, originalStatus = integracao.status;
  let consultado = 0;
  db.sessaoValida = async token => token === 'admin' ? { login: relatorios.admins()[0] } :
    token === 'colaborador' ? { login: 'colaborador.sem.acesso' } : null;
  integracao.status = async () => { consultado++; return { ativo: false, estados: [] }; };
  const app = express(); app.use('/hub/relatorios', relatorios.router);
  const servidor = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => servidor.once('listening', resolve));
    const url = `http://127.0.0.1:${servidor.address().port}/hub/relatorios/relogio-setor/status`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { 'X-Auth-Token': 'colaborador' } })).status, 403);
    assert.equal(consultado, 0);
    const permitido = await fetch(url, { headers: { 'X-Auth-Token': 'admin' } });
    assert.equal(permitido.status, 200);
    assert.equal(permitido.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await permitido.json(), { ativo: false, estados: [] });
    assert.equal(consultado, 1);
  } finally {
    db.sessaoValida = originalSessao; integracao.status = originalStatus;
    await new Promise(resolve => servidor.close(resolve));
  }
});
