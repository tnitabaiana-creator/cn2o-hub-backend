'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../protocolo-cadastro');
const cal = require('../horas-uteis');
const H = s => s + ':00-03:00';
const b0 = { id: P.BOARDS.protocolo }, b1 = { id: P.BOARDS.tabeliao };
const l = (key, name = key) => ({ id: P.LISTAS[key] || key, name });
const card = { id: 'card-teste', name: 'Prot. (CV) 1200 - EXEMPLO', shortLink: 'AbC123' };
const ev = (id, tipo, hora, dados) => ({ action_id: id, tipo, card_id: card.id, ocorrido_em: H(hora), dados: { card, ...dados } });
const entrada = (hora = '2026-09-21T09:00', id = 'entrada') => ev(id, 'updateCard', hora, { board: b0, listBefore: l('protocolo'), listAfter: l('digitalizacao') });
const mover = (id, hora, antes, depois) => ev(id, 'updateCard', hora, { board: b0, listBefore: l(antes), listAfter: l(depois) });
const entrega = (hora = '2026-09-21T11:00', id = 'entrega') => ev(id, 'moveCardToBoard', hora, { board: b1, boardSource: b0, list: l('gerar_minuta') });
const saida = (hora = '2026-09-21T11:00', id = 'saida', lista = 'cadastro') => ev(id, 'moveCardFromBoard', hora, { board: b0, boardTarget: b1, list: l(lista) });
const op = { semana: '2026-09-23', agora: new Date(H('2026-09-28T10:00')) };
const completo = () => [entrada(), mover('cadastro', '2026-09-21T10:00', 'digitalizacao', 'cadastro'), saida(), entrega()];

test('semana civil local, corte parcial real, datas impossíveis e futuro rejeitados', () => {
  assert.deepEqual(P.periodo('2026-09-23', H('2026-09-28T10:00')), { inicio: '2026-09-21', fim: '2026-09-27', corte: '2026-09-28T03:00:00.000Z', parcial: false });
  assert.equal(P.periodo('2026-09-23', H('2026-09-23T14:35')).corte, '2026-09-23T17:35:00.000Z');
  assert.equal(P.periodo('2026-09-23', H('2026-09-23T14:35')).parcial, true);
  for (const data of ['2026-02-30', '2026-13-01', 'amanhã', '2027-01-01']) assert.throws(() => P.periodo(data, H('2026-09-23T14:35')), /data válida|não começou/);
});

test('ciclo completo conta uma entrega e duas horas, com ações rastreáveis', () => {
  const r = P.calcular(completo(), op), c = r.ciclos[0];
  assert.equal(r.resumo.concluidos, 1); assert.equal(r.resumo.ciclos_concluidos, 1);
  assert.equal(c.horas_uteis, 2); assert.equal(c.protocolo, 1200); assert.equal(c.cadastro_confirmado, true);
  assert.equal(c.action_entrada, 'entrada'); assert.equal(c.action_saida, 'saida'); assert.equal(c.action_conclusao, 'entrega');
  assert.equal(r.resumo.no_prazo, 1); assert.equal(r.cobertura.confirmada, false);
});

test('conferência intermediária mantém a evidência de Cadastro e o prazo integral', () => {
  const r = P.calcular([entrada(), mover('cadastro', '2026-09-21T10:00', 'digitalizacao', 'cadastro'),
    mover('conferencia', '2026-09-21T11:00', 'cadastro', 'conferencia'), entrega('2026-09-21T15:00')], op);
  assert.equal(r.resumo.concluidos, 1); assert.equal(r.ciclos[0].horas_uteis, 5); assert.equal(r.ciclos[0].cadastro_confirmado, true);
});

test('ausência Cadastro é aviso, preserva entrega e tempo: decisão do titular', () => {
  const r = P.calcular([entrada(), entrega()], op);
  assert.equal(r.resumo.concluidos, 1); assert.equal(r.resumo.pendencias, 0);
  assert.equal(r.ciclos[0].horas_uteis, 2); assert.equal(r.ciclos[0].cadastro_confirmado, false);
  assert.match(r.ciclos[0].motivo, /sem saída de Cadastro/);
  assert.equal(r.criterio.exigir_cadastro, false);
});

test('não cria hora zero quando entrada Digitalização está ausente', () => {
  const r = P.calcular([saida(), entrega()], op);
  assert.equal(r.resumo.concluidos, 1); assert.equal(r.resumo.sem_tempo, 1);
  assert.equal(r.resumo.no_prazo, 0); assert.equal(r.resumo.media_horas_uteis, null);
  assert.equal(r.ciclos[0].horas_uteis, null); assert.equal(r.ciclos[0].no_prazo, null);
});

test('entrega inequívoca do Protocolo sem início/cadastro preserva quantidade observada, nunca inventa tempo', () => {
  const r = P.calcular([entrega()], op);
  assert.equal(r.resumo.concluidos, 1); assert.equal(r.resumo.sem_tempo, 1); assert.equal(r.ciclos[0].cadastro_confirmado, false);
});

test('pares duplicados, invertidos ou milissegundos separados não geram estoque fantasma', () => {
  const s = saida('2026-09-21T11:00', 'zz-saida'), e = entrega('2026-09-21T11:00', 'aa-entrega');
  s.ocorrido_em = '2026-09-21T14:00:00.005Z';
  const r = P.calcular([e, s, entrada(), e, s], op);
  assert.equal(r.resumo.ciclos_concluidos, 1); assert.equal(r.resumo.em_andamento, 0); assert.equal(r.ciclos.length, 1);
  assert.equal(r.ciclos[0].action_saida, 'zz-saida');
});

test('chegada de outro board não é entrega do setor e não casa com saída próxima', () => {
  const e = entrega(); e.dados.boardSource = { id: 'outro' };
  const r = P.calcular([entrada(), saida(), e], op);
  assert.equal(r.resumo.concluidos, 0); assert.equal(r.resumo.em_andamento, 0); assert.equal(r.resumo.pendencias, 1);
});

test('saída Cadastro sem chegada Gerar nunca é conclusão', () => {
  const r = P.calcular([entrada(), saida()], op);
  assert.equal(r.resumo.concluidos, 0); assert.equal(r.resumo.em_andamento, 0); assert.equal(r.resumo.pendencias, 1);
});

test('entrada anterior à semana continua válida para conclusão da semana', () => {
  const r = P.calcular([entrada('2026-09-18T16:00'), entrega('2026-09-21T09:00')], op);
  assert.equal(r.resumo.entradas, 0); assert.equal(r.resumo.concluidos, 1); assert.equal(r.ciclos[0].horas_uteis, 2);
});

test('almoço, fim de semana e feriado não consomem prazo', () => {
  const r = P.calcular([entrada('2026-10-09T16:00'), entrega('2026-10-13T09:00')], { semana: '2026-10-13', agora: H('2026-10-13T10:00') });
  assert.equal(r.ciclos[0].horas_uteis, 2); assert.equal(r.criterio.meta_horas_uteis, 8);
});

test('SLA compara horas sem arredondar: oito horas e um segundo já ultrapassam', () => {
  const e = entrega('2026-09-22T09:00'); e.ocorrido_em = '2026-09-22T12:00:01.000Z';
  const r = P.calcular([entrada(), e], op);
  assert.equal(r.ciclos[0].horas_uteis, 8); assert.equal(r.ciclos[0].no_prazo, false); assert.equal(r.resumo.fora_prazo, 1);
});

test('reentrada antes da entrega mantém início e distingue retornos', () => {
  const r = P.calcular([entrada(), mover('cadastro', '2026-09-21T10:00', 'digitalizacao', 'cadastro'),
    entrada('2026-09-21T11:00', 'retorno'), entrega('2026-09-22T09:00')], op);
  assert.equal(r.resumo.ciclos_concluidos, 1); assert.equal(r.ciclos[0].retornos, 1); assert.equal(r.ciclos[0].horas_uteis, 8);
  assert.equal(r.resumo.protocolos_entrada_unicos, 1);
  assert.equal(r.resumo.entradas, 1); assert.equal(r.resumo.retornos_digitalizacao, 1); assert.equal(r.resumo.entradas_movimentos_total, 2);
});

test('nova passagem após entrega é retrabalho; cartão principal não duplica na semana', () => {
  const r = P.calcular([...completo(), entrada('2026-09-22T09:00', 'entrada2'), entrega('2026-09-22T10:00', 'entrega2')], op);
  assert.equal(r.resumo.concluidos, 1); assert.equal(r.resumo.ciclos_concluidos, 2); assert.equal(r.resumo.retrabalhos, 1);
  assert.equal(r.dias.reduce((s, d) => s + d.ciclos_concluidos, 0), 2);
});

test('estoque histórico no corte inclui entradas anteriores, mas não recebe eventos futuros', () => {
  const r = P.calcular([entrada('2026-09-18T16:00'), entrega('2026-09-23T15:00')], { semana: '2026-09-23', agora: H('2026-09-23T10:00') });
  assert.equal(r.resumo.concluidos, 0); assert.equal(r.resumo.em_andamento, 1); assert.equal(r.resumo.vencidos, 1);
});

test('arquivar interrompe a pasta sem convertê-la em entrega ou estoque aberto', () => {
  const arquivar = ev('arquivado', 'updateCard', '2026-09-21T10:00', { board: b0, list: l('digitalizacao'), old: { closed: false }, card: { ...card, closed: true } });
  const r = P.calcular([entrada(), arquivar], op);
  assert.equal(r.resumo.concluidos, 0); assert.equal(r.resumo.em_andamento, 0); assert.equal(r.ciclos[0].status, 'interrompido');
});

test('lista de arquivo sem closed não conserva estoque e atraso artificiais', () => {
  const arquivo = ev('arquivo', 'updateCard', '2026-09-22T10:00', { board: b0,
    listBefore: l('cadastro'), listAfter: l('arquivo', 'Arquivado ✔') });
  const r = P.calcular([entrada(), mover('cadastro', '2026-09-21T10:00', 'digitalizacao', 'cadastro'), arquivo], op);
  assert.equal(r.resumo.em_andamento, 0); assert.equal(r.resumo.vencidos, 0); assert.equal(r.resumo.concluidos, 0);
  assert.equal(r.resumo.pendencias, 1); assert.equal(r.ciclos[0].status, 'pendente');
  assert.equal(r.ciclos[0].finalizacao_nao_comprovada, true);
  assert.equal(r.ciclos[0].horas_uteis, null); assert.equal(r.ciclos[0].no_prazo, null);
  assert.equal(r.ciclos[0].fora_fluxo_em, '2026-09-22T13:00:00.000Z');
});

test('saída direto para escrevente é pendência de comprovação, não conclusão ou atraso do setor', () => {
  const s = saida(); s.dados.boardTarget = { id: 'board-escrevente' };
  const e = ev('direto', 'moveCardToBoard', '2026-09-21T11:00', { board: { id: 'board-escrevente' }, boardSource: b0,
    list: l('revisar', 'Revisar Minuta') });
  const r = P.calcular([entrada(), s, e], op);
  assert.equal(r.resumo.em_andamento, 0); assert.equal(r.resumo.concluidos, 0); assert.equal(r.resumo.vencidos, 0);
  assert.equal(r.resumo.pendencias, 1); assert.equal(r.ciclos[0].no_prazo, null);
});

test('outra etapa do Tabelião fica fora da fila, mas posterior Gerar ainda fecha ciclo sem reset', () => {
  const caixa = ev('caixa', 'moveCardToBoard', '2026-09-21T11:00', { board: b1, boardSource: b0,
    list: l('caixa', 'Caixa de Entrada') });
  const gerar = ev('gerar-depois', 'updateCard', '2026-09-22T10:00', { board: b1,
    listBefore: l('caixa', 'Caixa de Entrada'), listAfter: l('gerar_minuta') });
  const antes = P.calcular([entrada(), caixa, gerar], { ...op, agora: H('2026-09-21T16:00') });
  assert.equal(antes.resumo.em_andamento, 0); assert.equal(antes.resumo.pendencias, 1); assert.equal(antes.resumo.concluidos, 0);
  const depois = P.calcular([entrada(), caixa, gerar], op);
  assert.equal(depois.resumo.concluidos, 1); assert.equal(depois.resumo.pendencias, 0);
  assert.equal(depois.ciclos[0].horas_uteis, 9); assert.equal(depois.ciclos[0].no_prazo, false);
});

test('transferência inicial sem Digitalização permite reconhecer Gerar posterior sem inventar tempo', () => {
  const caixa = ev('caixa', 'moveCardToBoard', '2026-09-21T11:00', { board: b1, boardSource: b0,
    list: l('caixa', 'Caixa de Entrada') });
  const gerar = ev('gerar-depois', 'updateCard', '2026-09-22T10:00', { board: b1,
    listBefore: l('caixa', 'Caixa de Entrada'), listAfter: l('gerar_minuta') });
  const antes = P.calcular([caixa, gerar], { ...op, agora: H('2026-09-21T16:00') });
  assert.equal(antes.resumo.em_andamento, 0); assert.equal(antes.resumo.pendencias, 1);
  const depois = P.calcular([caixa, gerar], op);
  assert.equal(depois.resumo.concluidos, 1); assert.equal(depois.resumo.sem_tempo, 1);
  assert.equal(depois.ciclos[0].entrou_digitalizacao_em, null); assert.equal(depois.ciclos[0].horas_uteis, null);
  assert.equal(depois.resumo.pendencias, 0); assert.equal(depois.resumo.vencidos, 0);
});

test('retorno à conferência e Cadastro no mesmo quadro continua ativo sem pausa', () => {
  const r = P.calcular([entrada(), mover('conf', '2026-09-21T10:00', 'digitalizacao', 'conferencia'),
    mover('cadastro', '2026-09-21T11:00', 'conferencia', 'cadastro')], { ...op, agora: H('2026-09-22T10:00') });
  assert.equal(r.resumo.em_andamento, 1); assert.equal(r.resumo.vencidos, 1); assert.equal(r.ciclos[0].horas_uteis, 9);
});

test('saída antiga sem Gerar é pendência histórica separada, não fila eterna', () => {
  const r = P.calcular([entrada('2026-09-14T09:00'), ev('arquivo', 'updateCard', '2026-09-15T10:00', {
    board: b0, listBefore: l('digitalizacao'), listAfter: l('arquivo', 'Arquivo Geral') })], op);
  assert.equal(r.resumo.em_andamento, 0); assert.equal(r.resumo.vencidos, 0); assert.equal(r.resumo.pendencias, 0);
  assert.equal(r.resumo.pendencias_historicas, 1); assert.equal(r.ciclos.length, 0);
  assert.ok(r.avisos.some(a => /fora da fila antes desta semana/.test(a)));
});

test('reorganização posterior do arquivo não desloca a saída antiga para esta semana', () => {
  const eventos = [entrada('2026-09-14T09:00'), ev('fora', 'moveCardToBoard', '2026-09-15T10:00', {
    board: b1, boardSource: b0, list: l('conferir', 'Conferir Minuta') }),
    ev('arquivo', 'moveCardToBoard', '2026-09-21T10:00', { board: b0, boardSource: b1,
      list: l('arquivo', 'Arquivo Geral') }), mover('arquivo-final', '2026-09-22T10:00', 'arquivo', 'arquivo2')];
  eventos.at(-1).dados.listAfter.name = 'Arquivado ✔';
  const r = P.calcular(eventos, op);
  assert.equal(r.resumo.pendencias, 0); assert.equal(r.resumo.pendencias_historicas, 1);
  assert.equal(r.resumo.em_andamento, 0); assert.equal(r.resumo.vencidos, 0);
});

test('dados vazios preservam médias nulas e não afirmam cobertura', () => {
  const r = P.calcular([], op);
  assert.equal(r.resumo.media_horas_uteis, null); assert.equal(r.resumo.mediana_horas_uteis, null);
  assert.equal(r.cobertura.eventos, 0); assert.equal(r.cobertura.confirmada, false);
  assert.ok(r.avisos.some(a => /não comprova produtividade zero/.test(a)));
});

test('calendário configurado é respeitado e descrito', () => {
  const calendario = cal.criarCalendario({ expediente: '07:00-10:00,14:00-17:00', feriadosExtra: '2026-09-22' });
  const r = P.calcular([entrada(), entrega('2026-09-23T09:00')], { ...op, calendario });
  assert.equal(r.ciclos[0].horas_uteis, 6); assert.equal(r.criterio.expediente, '07:00–10:00, 14:00–17:00');
});

test('consultar usa uma fotografia SQL somente leitura e rejeita truncamento', async () => {
  let chamadas = 0;
  const r = await P.consultar({ ...op, query: async (sql, params) => {
    chamadas++; assert.match(sql, /^WITH candidatos/); assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE/);
    assert.equal(params[0], '2026-09-28T03:00:00.000Z'); return { rows: completo() };
  } });
  assert.equal(chamadas, 1); assert.equal(r.resumo.concluidos, 1);
  await assert.rejects(P.consultar({ ...op, query: async () => ({ rows: Array(150001).fill({}) }) }), /sem truncar/);
});

test('montagem herda bloqueio administrativo de relatorios e não cria rota pública', async () => {
  const express = require('express'), db = require('../db');
  const original = db.sessaoValida;
  db.sessaoValida = async token => token === 'colaborador' ? { login: 'colaborador.teste' } : null;
  const app = express(); app.use('/hub/relatorios', require('../relatorios').router);
  const servidor = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => servidor.once('listening', resolve));
    const url = `http://127.0.0.1:${servidor.address().port}/hub/relatorios/protocolo-cadastro/semanal`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { 'X-Auth-Token': 'colaborador' } })).status, 403);
  } finally { db.sessaoValida = original; await new Promise(resolve => servidor.close(resolve)); }
});
