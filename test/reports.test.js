'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../reports');
const { reconstruir } = require('../rastreio');
const { ESCREVENTES } = require('../db-relatorios');
const { periodo } = require('../relatorios');

const H = s => new Date(s + ':00-03:00');
const PESOS = {
  'CV-Urbano': { descricao: 'Compra e Venda (urbano)', peso: 1, horas_referencia: 4 },
  CDH: { descricao: 'Cessão de Direitos Hereditários', peso: 1.5, horas_referencia: 6 },
  INV: { descricao: 'Inventário e Partilha', peso: 2.5, horas_referencia: 10 },
  OUTROS: { descricao: 'Outros', peso: 1, horas_referencia: 4 }
};
const ESC = [{ login: 'lara.silva', nome: 'Lara' }, { login: 'romenia.oliveira', nome: 'Romênia' }];
const c = (escrevente, tipo_ato, horas_ativas, retornos = 0, extra = {}) => ({
  escrevente, tipo_ato, horas_ativas, horas_mesa: horas_ativas == null ? null : horas_ativas * 2,
  retornos, reaberturas: 0, historico_completo: horas_ativas != null, ...extra
});

test('mediana e percentil 75 (interpolação linear, como PERCENTILE_CONT)', () => {
  assert.equal(R.mediana([4, 1, 3, 2]), 2.5);
  assert.equal(R.p75([1, 2, 3, 4]), 3.25);
  assert.equal(R.mediana([7]), 7);
  assert.equal(R.p75([7]), 7);
  assert.equal(R.mediana([]), null);
  assert.equal(R.mediana([null, NaN, 5, undefined, 1]), 3);
  assert.equal(R.percentil([10, 20, 30, 40, 50], 0.75), 40);
});

test('referência por tipo: mediana da equipe com 3+ atos, senão a tabela', () => {
  const refs = R.referencias([c('a', 'CV-Urbano', 2), c('b', 'CV-Urbano', 6), c('a', 'CV-Urbano', 4), c('a', 'CDH', 9),
    c('a', 'CV-Urbano', null)], PESOS);
  assert.deepEqual(refs['CV-Urbano'], { horas: 4, fonte: 'equipe', n: 3 });   // o sem histórico não entra
  assert.deepEqual(refs.CDH, { horas: 6, fonte: 'tabela', n: 1 });
  assert.equal(refs.INV.fonte, 'tabela');
});

// janela de 90 dias: CV-Urbano da equipe = [2,3,4,6,8,10] → referência 5
const JANELA = [
  c('lara.silva', 'CV-Urbano', 2), c('lara.silva', 'CV-Urbano', 3), c('lara.silva', 'CV-Urbano', 4), c('lara.silva', 'CDH', 5),
  c('romenia.oliveira', 'CV-Urbano', 6), c('romenia.oliveira', 'CV-Urbano', 8), c('romenia.oliveira', 'CV-Urbano', 10),
  c('romenia.oliveira', 'INV', 20)
];
const PERIODO = { inicio: H('2026-09-21T00:00'), fim: H('2026-09-28T00:00'), inicioISO: '2026-09-21', fimISO: '2026-09-27' };
const CONCLUSOES = [
  c('lara.silva', 'CV-Urbano', 2), c('lara.silva', 'CV-Urbano', 4, 1), c('lara.silva', 'CDH', 5),
  c('romenia.oliveira', 'CV-Urbano', 10, 1), c('romenia.oliveira', 'INV', 20), c('romenia.oliveira', 'CV-Urbano', null)
];
const PENDENCIAS = [
  { escrevente: 'lara.silva', tipo: 'documental', aberta_em: H('2026-09-22T09:00'), fechada_em: H('2026-09-23T09:00'), horas_uteis: 8 },
  { escrevente: 'lara.silva', tipo: 'documental', aberta_em: H('2026-09-10T09:00'), fechada_em: null, horas_uteis: null },
  { escrevente: 'lara.silva', tipo: 'ajuste', aberta_em: H('2026-09-24T09:00'), fechada_em: null, horas_uteis: null },
  { escrevente: 'romenia.oliveira', tipo: 'documental', aberta_em: H('2026-09-26T09:00'), fechada_em: H('2026-09-29T09:00'), horas_uteis: 16 }
];

function relatorio() {
  return R.calcular({
    tipo: 'semanal', periodo: PERIODO, escreventes: ESC, pesos: PESOS, conclusoes: CONCLUSOES,
    anteriores: [c('lara.silva', 'CV-Urbano', 3), c('lara.silva', 'CDH', 6)], janela: JANELA, pendencias: PENDENCIAS,
    wip: { 'lara.silva': { total: 4, atrasados: 1 } }
  });
}

test('custo pessoal: índice = mediana(custo ÷ referência do tipo)', () => {
  const rel = relatorio();
  const lara = rel.escreventes.find(e => e.login === 'lara.silva');
  const rom = rel.escreventes.find(e => e.login === 'romenia.oliveira');
  assert.equal(lara.indice_custo, 0.8);          // mediana(2/5, 4/5, 5/6)
  assert.equal(rom.indice_custo, 2);             // mediana(10/5, 20/10); o sem histórico fica fora
  assert.equal(lara.mediana_ativa, 4);
  assert.equal(lara.p75_ativa, 4.5);
  assert.equal(lara.mediana_mesa, 8);
  assert.equal(rom.n_tempo, 2);
});

test('afinidade: referência da equipe ÷ mediana dela, só com 3+ atos do tipo', () => {
  const rel = relatorio();
  const lara = rel.escreventes.find(e => e.login === 'lara.silva');
  const rom = rel.escreventes.find(e => e.login === 'romenia.oliveira');
  assert.deepEqual(lara.afinidade, [{ tipo: 'CV-Urbano', n: 3, mediana_ativa: 3, referencia: 5, indice: 1.67 }]);
  assert.deepEqual(rom.afinidade.map(a => [a.tipo, a.indice]), [['CV-Urbano', 0.63]]);   // INV: 1 ato só
  assert.match(lara.leitura, /20% abaixo/);
  assert.match(lara.leitura, /Afinidade com CV-Urbano/);
  assert.doesNotMatch(rom.leitura, /Custo pessoal/);   // só 2 atos com tempo: amostra pequena para comentar
});

test('volume, pontos, variação e taxa de retorno', () => {
  const rel = relatorio();
  const lara = rel.escreventes.find(e => e.login === 'lara.silva');
  const rom = rel.escreventes.find(e => e.login === 'romenia.oliveira');
  assert.equal(lara.concluidos, 3);
  assert.equal(lara.pontos, 3.5);
  assert.equal(lara.variacao, 0.5);              // 3 contra 2 no período anterior
  assert.equal(rom.variacao, null);              // período anterior vazio
  assert.equal(lara.taxa_retorno, 0.33);
  assert.deepEqual(rom.mix, [{ tipo: 'CV-Urbano', n: 2 }, { tipo: 'INV', n: 1 }]);
  assert.deepEqual(lara.wip, { total: 4, atrasados: 1 });
  assert.equal(rel.equipe.concluidos, 6);
  assert.equal(rel.equipe.pontos, 8);
  assert.equal(rel.equipe.sem_historico, 1);
  assert.equal(rel.equipe.taxa_retorno, 0.33);
  assert.deepEqual(rel.por_tipo.map(t => [t.tipo, t.n, t.referencia, t.fonte_referencia]),
    [['CV-Urbano', 4, 5, 'equipe'], ['CDH', 1, 6, 'tabela'], ['INV', 1, 10, 'tabela']]);
});

test('pendências: abertas no período, em aberto no fim, mediana das encerradas', () => {
  const rel = relatorio();
  const lara = rel.escreventes.find(e => e.login === 'lara.silva').pendencias;
  const rom = rel.escreventes.find(e => e.login === 'romenia.oliveira').pendencias;
  assert.deepEqual(lara.documental, { abertas: 1, em_aberto: 1, encerradas: 1, mediana_horas: 8 });
  assert.deepEqual(lara.ajuste, { abertas: 1, em_aberto: 1, encerradas: 0, mediana_horas: null });
  assert.deepEqual(rom.documental, { abertas: 1, em_aberto: 1, encerradas: 0, mediana_horas: null });
  assert.equal(rel.equipe.pendencias.documental.em_aberto, 2);
});

test('datas simuladas: fim de semana e feriado de 07/09 fora do custo pessoal', () => {
  const [, , board, finalizado] = ESCREVENTES.find(e => e[0] === 'lara.silva');
  const escreventes = ESCREVENTES.map(([login, nome, board_id, list_finalizado_id]) => ({ login, nome, board_id, list_finalizado_id }));
  const card = { id: 'x', name: 'Prot. (CV-Urbano) 1600 - TESTE' };
  const r = reconstruir([
    { action_id: 'a1', tipo: 'moveCardToBoard', ocorrido_em: H('2026-09-04T16:00'),       // sexta 16h
      dados: { card, board: { id: board }, list: { id: 'l1', name: 'Revisar Minuta' } } },
    { action_id: 'a2', tipo: 'updateCard', ocorrido_em: H('2026-09-08T09:00'),            // terça 9h
      dados: { card, board: { id: board }, listBefore: { id: 'l1', name: 'Revisar Minuta' },
        listAfter: { id: finalizado, name: 'Finalizado' } } }
  ], { escreventes });
  assert.equal(r.conclusao.horas_ativas, 2);      // 1 h na sexta + 1 h na terça (89 h corridas)
  const per = periodo('semanal', '2026-09-14');   // semana de 07 a 13/09
  const rel = R.calcular({ tipo: 'semanal', periodo: per, escreventes: ESC, pesos: PESOS,
    conclusoes: [r.conclusao], janela: [r.conclusao] });
  assert.equal(rel.escreventes[0].mediana_ativa, 2);
  assert.equal(rel.escreventes[0].mediana_mesa, 2);
  assert.equal(rel.escreventes[0].indice_custo, 0.5);   // 2 ÷ referência da tabela (4)
});

test('período vazio não quebra', () => {
  const rel = R.calcular({ tipo: 'mensal', periodo: PERIODO, escreventes: ESC, pesos: PESOS });
  assert.equal(rel.equipe.concluidos, 0);
  assert.equal(rel.equipe.mediana_mesa, null);
  assert.equal(rel.equipe.taxa_retorno, null);
  assert.equal(rel.escreventes[0].leitura, 'Sem atos concluídos no período.');
  assert.deepEqual(rel.por_tipo, []);
});
