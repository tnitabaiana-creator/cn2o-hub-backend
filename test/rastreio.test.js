'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { assinaturaValida, verificarWebhook, categoriaDaLista, reconstruir, relevante } = require('../rastreio');
const { ESCREVENTES } = require('../db-relatorios');

const escreventes = ESCREVENTES.map(([login, nome, board_id, list_finalizado_id]) => ({ login, nome, board_id, list_finalizado_id }));
const LARA = escreventes.find(e => e.login === 'lara.silva');
const ROMENIA = escreventes.find(e => e.login === 'romenia.oliveira');
const B00 = { id: '692e0379fa55156e778f27ef', name: '00. Protocolo/Cadastro' };
const B01 = { id: '692e06a94b807c2a1816d992', name: '01. TABELIÃO' };
const BLARA = { id: LARA.board_id, name: '02. ESCREVENTE LARA' };
const lista = (id, name) => ({ id, name });
const L = {
  entrada: lista('692e04b1eb7cbc358301a32e', 'Protocolo/Entrada'),
  arquivo: lista('69344a6fc5e00099568028f9', 'Arquivo Geral'),
  pend01: lista('698f7de491e9ccd0d7303a91', 'PENDÊNCIAS'),
  revisar: lista('692e0a2c4ad155c0fcd88ab8', 'Revisar Minuta'),
  conf: lista('692e0a44b382b57311bf7f6c', 'Conferência de Minuta'),
  ajuste: lista('692e0a503ae84e9e7e80289f', 'Ajuste/Retorno'),
  agendar: lista('692e0a67e86ea541264e56c9', 'Agendar Assinatura'),
  final: lista(LARA.list_finalizado_id, 'Finalizado'),
  arquivar: lista('694d86f07fee102e3cc9fc94', 'Arquivar')
};
const CARD = { id: 'c1', name: 'Prot. (CV-Urbano) 1400 - JOSÉ DA SILVA', shortLink: 'abc123' };
const H = s => s + ':00-03:00';
let seq = 0;
const ev = (tipo, quando, dados) => ({ action_id: 'a' + String(++seq).padStart(4, '0'), tipo, ocorrido_em: H(quando), dados: { card: CARD, ...dados } });
const mover = (quando, de, para, board = BLARA) => ev('updateCard', quando, { board, listBefore: de, listAfter: para, old: { idList: de.id } });
const ctx = { escreventes };

// Ciclo completo: protocolo → mesa da Lara → conferência → ajuste → assinatura →
// Finalizado → volta para ajuste (reabertura) → Finalizado → arquivo no 00.
function cicloCompleto() {
  seq = 0;
  return [
    ev('createCard', '2026-09-14T09:00', { board: B00, list: L.entrada }),
    ev('moveCardFromBoard', '2026-09-14T10:00', { board: B00, boardTarget: { id: BLARA.id }, list: L.entrada }),
    ev('moveCardToBoard', '2026-09-14T10:00', { board: BLARA, boardSource: { id: B00.id }, list: L.revisar }),
    mover('2026-09-15T10:00', L.revisar, L.conf),
    mover('2026-09-15T14:00', L.conf, L.ajuste),
    mover('2026-09-16T09:00', L.ajuste, L.conf),
    mover('2026-09-16T11:00', L.conf, L.agendar),
    mover('2026-09-17T10:00', L.agendar, L.final),
    mover('2026-09-17T11:00', L.final, L.ajuste),
    mover('2026-09-17T15:00', L.ajuste, L.final),
    mover('2026-09-18T09:00', L.final, L.arquivar),
    ev('moveCardFromBoard', '2026-09-18T10:00', { board: BLARA, boardTarget: { id: B00.id }, list: L.arquivar }),
    ev('moveCardToBoard', '2026-09-18T10:00', { board: B00, boardSource: { id: BLARA.id }, list: L.arquivo })
  ];
}

test('assinatura HMAC do Trello: UTF-8, forma "binary" do exemplo oficial, e rejeições', () => {
  const segredo = 'segredo-da-chave', url = 'https://hub.exemplo/webhook/trello';
  const corpo = Buffer.from(JSON.stringify({ action: { data: { card: { name: 'Prot. (CDH) 1500 - ROMÊNIA' } } } }), 'utf8');
  const utf8 = crypto.createHmac('sha1', segredo).update(Buffer.concat([corpo, Buffer.from(url)])).digest('base64');
  const binario = crypto.createHmac('sha1', segredo).update(corpo.toString('utf8') + url, 'latin1').digest('base64');
  assert.notEqual(utf8, binario);                      // com acento as duas formas diferem
  assert.ok(assinaturaValida(corpo, utf8, segredo, url));
  assert.ok(assinaturaValida(corpo, binario, segredo, url));
  assert.ok(!assinaturaValida(corpo, utf8, 'outro-segredo', url));
  assert.ok(!assinaturaValida(corpo, utf8, segredo, url + '/'));
  assert.ok(!assinaturaValida(Buffer.from(corpo.toString().replace('1500', '1501')), utf8, segredo, url));
  assert.ok(!assinaturaValida(corpo, undefined, segredo, url));
  assert.ok(!assinaturaValida(corpo, 'curta', segredo, url));
});

test('verificarWebhook: sem TRELLO_SECRET não rastreia; com ele, confere contra BASE_URL', () => {
  const antes = { ...process.env };
  try {
    delete process.env.TRELLO_SECRET;
    assert.equal(verificarWebhook(Buffer.from('{}'), 'x'), 'sem-segredo');
    Object.assign(process.env, { TRELLO_SECRET: 's', BASE_URL: 'https://hub.exemplo/' });
    delete process.env.TRELLO_WEBHOOK_URL;
    const corpo = Buffer.from('{"action":{}}');
    const assinar = url => crypto.createHmac('sha1', 's').update(Buffer.concat([corpo, Buffer.from(url)])).digest('base64');
    assert.equal(verificarWebhook(corpo, assinar('https://hub.exemplo/webhook/trello')), 'ok');
    // o setup.js do hub registra `${BASE_URL}/webhook/trello` sem tirar a barra final
    assert.equal(verificarWebhook(corpo, assinar('https://hub.exemplo//webhook/trello')), 'ok');
    assert.equal(verificarWebhook(corpo, assinar('https://outro.exemplo/webhook/trello')), 'invalida');
    assert.equal(verificarWebhook(corpo, 'errada'), 'invalida');
    // com TRELLO_WEBHOOK_URL, só ela vale
    process.env.TRELLO_WEBHOOK_URL = 'https://registrada.exemplo/webhook/trello';
    assert.equal(verificarWebhook(corpo, assinar('https://registrada.exemplo/webhook/trello')), 'ok');
    assert.equal(verificarWebhook(corpo, assinar('https://hub.exemplo/webhook/trello')), 'invalida');
  } finally {
    for (const k of ['TRELLO_SECRET', 'BASE_URL', 'TRELLO_WEBHOOK_URL']) {
      if (k in antes) process.env[k] = antes[k]; else delete process.env[k];
    }
  }
});

test('só entram as ações que mudam a posição (ou o título) do cartão', () => {
  assert.ok(relevante({ id: '1', type: 'updateCard', data: { card: { id: 'c' }, listAfter: {}, listBefore: {} } }));
  assert.ok(relevante({ id: '1', type: 'updateCard', data: { card: { id: 'c', closed: true }, old: { closed: false } } }));
  assert.ok(!relevante({ id: '1', type: 'updateCard', data: { card: { id: 'c' }, old: { due: null } } }));
  assert.ok(!relevante({ id: '1', type: 'commentCard', data: { card: { id: 'c' } } }));
  assert.ok(relevante({ id: '1', type: 'moveCardToBoard', data: { card: { id: 'c' } } }));
  assert.ok(!relevante({ id: '1', type: 'createCard', data: {} }));
  assert.ok(!relevante(null));
});

test('categorias das listas reais dos quadros', () => {
  const casos = {
    'Revisar Minuta': 'elaboracao', 'Conferência de Minuta': 'conferencia', 'Ajuste/Retorno': 'retrabalho',
    'Agendar Assinatura': 'assinatura', 'Aguardando Assinatura': 'assinatura', Finalizado: 'finalizado',
    Arquivar: 'arquivo', 'PENDÊNCIAS': 'pendencia', AGUARDA: 'pendencia', 'Aguarda Auditoria': 'conferencia',
    'Conferir Minuta': 'conferencia', 'MESA TABELIÃO': 'conferencia', '🤖 Gerar Minuta': 'elaboracao',
    'Protocolo/Entrada': 'entrada', 'Em Digitalização': 'entrada', 'Cadastro Extradigital': 'entrada',
    'Pré-protocolo (Site)': 'entrada', 'Em Conferência': 'conferencia', 'Arquivo Geral': 'arquivo',
    'Escrituras Sem Efeito': 'arquivo', 'Enotariado/Onr': 'outros', '': 'fora', null: 'fora'
  };
  for (const [nome, cat] of Object.entries(casos)) assert.equal(categoriaDaLista(nome === 'null' ? null : nome), cat, nome);
});

test('ciclo completo: passagens em horas úteis e uma conclusão, com a reabertura contada', () => {
  const r = reconstruir(cicloCompleto(), ctx);
  const resumo = r.passagens.map(p => [p.list_nome, p.categoria, p.escrevente, p.horas_uteis]);
  assert.deepEqual(resumo, [
    ['Protocolo/Entrada', 'entrada', null, 1],
    ['Revisar Minuta', 'elaboracao', 'lara.silva', 8],
    ['Conferência de Minuta', 'conferencia', 'lara.silva', 3],
    ['Ajuste/Retorno', 'retrabalho', 'lara.silva', 4],
    ['Conferência de Minuta', 'conferencia', 'lara.silva', 2],
    ['Agendar Assinatura', 'assinatura', 'lara.silva', 7],
    ['Finalizado', 'finalizado', 'lara.silva', 1],
    ['Ajuste/Retorno', 'retrabalho', 'lara.silva', 3],
    ['Finalizado', 'finalizado', 'lara.silva', 3],
    ['Arquivar', 'arquivo', 'lara.silva', 1],
    ['Arquivo Geral', 'arquivo', null, null]                // ainda está lá
  ]);
  assert.equal(r.passagens[r.passagens.length - 1].saiu_em, null);
  const c = r.conclusao;
  assert.equal(c.escrevente, 'lara.silva');
  assert.equal(c.protocolo, 1400);
  assert.equal(c.tipo_ato, 'CV-Urbano');
  assert.equal(c.card_short, 'abc123');
  assert.equal(new Date(c.concluido_em).toISOString(), new Date(H('2026-09-17T10:00')).toISOString());
  assert.equal(new Date(c.ultima_conclusao_em).toISOString(), new Date(H('2026-09-17T15:00')).toISOString());
  assert.equal(c.reaberturas, 1);
  assert.equal(c.horas_mesa, 27);          // seg 10h → qui 15h (28 h), menos 1 h em Finalizado antes da reabertura
  assert.equal(c.horas_ativas, 15);        // Revisar 8 + Ajuste 4 + Ajuste 3
  assert.equal(c.horas_conferencia, 5);
  assert.equal(c.horas_assinatura, 7);
  assert.equal(c.horas_pendencia, 0);
  assert.equal(c.retornos, 2);
  assert.equal(c.historico_completo, true);
  assert.deepEqual(r.pendencias.map(p => [p.tipo, p.escrevente, p.horas_uteis]), [
    ['ajuste', 'lara.silva', 4], ['ajuste', 'lara.silva', 3]
  ]);
});

test('ordem de chegada dos eventos não muda o resultado (idempotência da reconstrução)', () => {
  const eventos = cicloCompleto();
  const base = reconstruir(eventos, ctx);
  const embaralhado = [...eventos].reverse();
  [embaralhado[2], embaralhado[7]] = [embaralhado[7], embaralhado[2]];
  assert.deepEqual(reconstruir(embaralhado, ctx), base);
  assert.deepEqual(reconstruir(eventos, ctx), base);
});

test('protocolo do banco prevalece sobre o título; título editado à mão vale o último', () => {
  const eventos = cicloCompleto();
  eventos.push(ev('updateCard', '2026-09-18T11:00', { board: B00, card: { ...CARD, name: 'Prot. (DOA) 1400 - JOSÉ' }, old: { name: CARD.name } }));
  assert.equal(reconstruir(eventos, ctx).conclusao.tipo_ato, 'DOA');
  assert.equal(reconstruir(eventos, { ...ctx, protocolo: { numero: 1399, ato: 'CV-Rural' } }).conclusao.tipo_ato, 'CV-Rural');
  assert.equal(reconstruir(eventos, { ...ctx, protocolo: { numero: 1399, ato: 'CV-Rural' } }).conclusao.protocolo, 1399);
});

test('cartão anterior à carga: início desconhecido → conta, mas sem tempos', () => {
  seq = 0;
  const r = reconstruir([
    mover('2026-09-15T10:00', L.revisar, L.conf),
    mover('2026-09-16T10:00', L.conf, L.final)
  ], ctx);
  assert.equal(r.passagens[0].entrou_em, null);
  assert.equal(r.passagens[0].horas_uteis, null);
  assert.equal(r.passagens[0].action_entrada, '?a0001');
  assert.equal(r.conclusao.historico_completo, false);
  assert.equal(r.conclusao.horas_mesa, null);
  assert.equal(r.conclusao.horas_ativas, null);
});

test('pendência no quadro do Tabelião vai para a escrevente responsável pelo cartão', () => {
  seq = 0;
  const r = reconstruir([
    ev('moveCardToBoard', '2026-09-14T09:00', { board: BLARA, list: L.revisar }),
    ev('moveCardToBoard', '2026-09-14T11:00', { board: B01, list: L.pend01 }),
    ev('moveCardToBoard', '2026-09-15T11:00', { board: BLARA, list: L.revisar }),
    mover('2026-09-15T15:00', L.revisar, L.final)
  ], ctx);
  assert.deepEqual(r.pendencias.map(p => [p.tipo, p.escrevente, p.horas_uteis, p.list_nome]), [
    ['documental', 'lara.silva', 8, 'PENDÊNCIAS']
  ]);
  assert.equal(r.conclusao.horas_pendencia, 8);
  assert.equal(r.conclusao.horas_ativas, 2 + 3);     // 9h→11h e 11h→15h (almoço fora)
  assert.equal(r.conclusao.horas_mesa, 2 + 8 + 3);
});

test('troca de escrevente: a conclusão e o custo são de quem finalizou', () => {
  seq = 0;
  const BROM = { id: ROMENIA.board_id };
  const r = reconstruir([
    ev('moveCardToBoard', '2026-09-14T09:00', { board: BLARA, list: L.revisar }),
    ev('moveCardToBoard', '2026-09-14T13:00', { board: BROM, list: lista('692e0985632c7a9974282df3', 'Revisar Minuta') }),
    ev('updateCard', '2026-09-14T15:00', { board: BROM, listBefore: lista('692e0985632c7a9974282df3', 'Revisar Minuta'),
      listAfter: lista(ROMENIA.list_finalizado_id, 'Finalizado') })
  ], ctx);
  assert.equal(r.conclusao.escrevente, 'romenia.oliveira');
  assert.equal(r.conclusao.horas_ativas, 2);
  assert.equal(r.conclusao.horas_mesa, 2);
});

test('arquivar e desarquivar; ida a quadro não monitorado', () => {
  seq = 0;
  const r = reconstruir([
    ev('createCard', '2026-09-14T09:00', { board: BLARA, list: L.revisar }),
    ev('updateCard', '2026-09-14T10:00', { board: BLARA, list: L.revisar, card: { ...CARD, closed: true }, old: { closed: false } }),
    ev('updateCard', '2026-09-14T11:00', { board: BLARA, list: L.revisar, card: { ...CARD, closed: false }, old: { closed: true } }),
    ev('moveCardFromBoard', '2026-09-14T12:00', { board: BLARA, boardTarget: { id: 'quadro-04' }, list: L.revisar })
  ], ctx);
  assert.deepEqual(r.passagens.map(p => [p.list_nome, p.categoria, p.horas_uteis]), [
    ['Revisar Minuta', 'elaboracao', 1],
    ['Revisar Minuta', 'elaboracao', 1],
    [null, 'fora', null]
  ]);
  assert.equal(r.passagens[2].board_id, 'quadro-04');
  assert.equal(r.conclusao, null);
});
