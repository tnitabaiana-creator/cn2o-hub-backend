'use strict';
// v1.40 — Relatórios · produtividade em reais: validação, carga inicial, rotas e IA.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db');
const P = require('../produtividade');

const INICIAL = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dados', 'produtividade-inicial.json'), 'utf8'));
const clone = o => JSON.parse(JSON.stringify(o));
const fetchReal = global.fetch;   // o teste da IA troca o fetch global (Gemini); os pedidos às rotas usam o real

test('carga inicial: junho a agosto de 2026 passam na validação, com os números do painel anterior', () => {
  assert.deepEqual(INICIAL.map(m => [m.ano, m.mes]), [[2026, 6], [2026, 7], [2026, 8]]);
  const [jun, jul, ago] = INICIAL.map(m => P.validarDados(m.dados));
  assert.equal(jun.total, 357758.57); assert.equal(jun.atos, 5324); assert.equal(jun.serie.dias.length, 20);
  assert.equal(jun.serie.porPessoa['LARA.SILVA'].length, 20);
  assert.equal(jul.faixas, null);                       // julho veio sem faixas
  assert.equal(ago.serie, null);                        // agosto veio sem data
  assert.equal(ago.pessoas.reduce((s, p) => s + p.atos, 0), 5992);
  assert.ok(ago.pessoas.some(p => p.id === 'CARTÓRIO - NÃO UTILIZAR'));
});

test('validação: só números e textos curtos; série com tamanho certo; nada de pessoa repetida', () => {
  const base = clone(INICIAL[0].dados);
  const mexe = f => { const d = clone(base); f(d); return () => P.validarDados(d); };
  assert.throws(mexe(d => { d.pessoas[0].total = 'muito'; }), /total de LARA.SILVA inválido/);
  assert.throws(mexe(d => { d.pessoas[1].id = d.pessoas[0].id; }), /pessoa repetida/);
  assert.throws(mexe(d => { d.diasUteis = 40; }), /dias úteis inválido/);
  assert.throws(mexe(d => { d.serie.total.pop(); }), /tamanho errado/);
  assert.throws(mexe(d => { d.serie.dias[0] = '01/06/2026'; }), /dia inválido/);
  assert.throws(mexe(d => { d.faixas.pop(); }), /faixas de valor incompletas/);
  assert.throws(mexe(d => { d.pessoas = []; }), /nenhuma pessoa/);
  const ok = P.validarDados(Object.assign(clone(base), { pessoas: base.pessoas.map((p, i) => i ? p : Object.assign({}, p, { nome: '<img src=x onerror=alert(1)>Lara' })) }));
  assert.doesNotMatch(ok.pessoas[0].nome, /[<>]/);      // texto sem marcação
  const semPessoaDesconhecida = clone(base);
  semPessoaDesconhecida.serie.porPessoa.INTRUSO = base.serie.total;
  assert.equal(P.validarDados(semPessoaDesconhecida).serie.porPessoa.INTRUSO, undefined);
});

test('dias úteis do mês pelo calendário do Hub (feriados nacionais e de Sergipe)', () => {
  assert.equal(P.diasUteisDoMes('2026-08'), 21);
  assert.equal(P.diasUteisDoMes('2026-07'), 22);        // 08/07, emancipação de Sergipe, fora
});

test('IA: o pacote leva só totais e perfis; a resposta é filtrada', () => {
  const mes = { chave: '2026-08', dados: P.validarDados(clone(INICIAL[2].dados)) };
  const ant = { chave: '2026-07', dados: P.validarDados(clone(INICIAL[1].dados)) };
  const pac = P.resumoParaIA(mes, ant, { 'lara.silva': 'Lara' }, P.CONFIG_PADRAO);
  const lara = pac.pessoas.find(p => p.id === 'LARA.SILVA');
  assert.equal(lara.nome, 'Lara');
  assert.equal(lara.perfil, 'mesa de escrituras');
  assert.equal(pac.pessoas.find(p => p.id === 'HELLEN.LIMA').perfil, 'balcão');
  assert.equal(pac.pessoas.find(p => p.id === 'CESAR.BRAVO').perfil, 'tabelião');
  assert.equal(pac.pessoas.find(p => p.id === 'CARTÓRIO - NÃO UTILIZAR').perfil, 'sistema');
  assert.equal(pac.mes_anterior.mes, '2026-07');
  const a = P.limparAnalise({ resumo: 'ok', pessoas: [{ id: 'LARA.SILVA', texto: 'bom' }, { id: 'INVENTADO', texto: 'x' }],
    observacoes: ['a', '', 'b'], alertas: [{ titulo: 't', detalhe: 'd', nivel: 'atencao' }, { titulo: '', detalhe: 'sem título' }, { titulo: 'u', nivel: 'grave' }] },
  new Set(mes.dados.pessoas.map(p => p.id)));
  assert.deepEqual(a.pessoas.map(p => p.id), ['LARA.SILVA']);
  assert.deepEqual(a.observacoes, ['a', 'b']);
  assert.deepEqual(a.alertas.map(x => x.nivel), ['atencao', 'info']);
});

// ---------------------------------------------------------------- rotas (banco simulado)
const USUARIOS = { 'tok-cesar': { login: 'cesar.bravo', nome: 'César' }, 'tok-lara': { login: 'lara.silva', nome: 'Lara' } };
const banco = { meses: new Map(), config: null, gravacoes: [] };
let base, srv;
test.before(async () => {
  INICIAL.forEach(m => banco.meses.set(m.ano + '-' + m.mes, { ano: m.ano, mes: m.mes, dados: P.validarDados(m.dados), fonte: m.fonte, importado_por: 'painel anterior', importado_em: new Date(), analise: null, analise_em: null }));
  db.sessaoValida = async t => USUARIOS[t] || null;
  db.pool.query = async (sql, p) => {
    if (/FROM produtividade_mes ORDER BY/.test(sql)) return { rows: [...banco.meses.values()].sort((a, b) => a.ano - b.ano || a.mes - b.mes) };
    if (/FROM produtividade_config/.test(sql)) return { rows: banco.config ? [{ valor: banco.config }] : [] };
    if (/INSERT INTO produtividade_config/.test(sql)) { banco.config = JSON.parse(p[0]); return { rows: [] }; }
    if (/FROM usuarios/.test(sql)) return { rows: [{ login: 'lara.silva', nome: 'Lara' }, { login: 'cesar.bravo', nome: 'César' }] };
    if (/INSERT INTO produtividade_mes/.test(sql)) { banco.gravacoes.push(p); banco.meses.set(p[0] + '-' + p[1], { ano: p[0], mes: p[1], dados: JSON.parse(p[2]), fonte: p[3], importado_por: p[4], analise: null }); return { rows: [] }; }
    if (/DELETE FROM produtividade_mes/.test(sql)) { const k = p[0] + '-' + p[1]; const tinha = banco.meses.delete(k); return { rows: tinha ? [{ ano: p[0] }] : [] }; }
    if (/UPDATE produtividade_mes SET analise/.test(sql)) { banco.meses.get(p[0] + '-' + p[1]).analise = JSON.parse(p[2]); return { rows: [] }; }
    if (/FROM consumo/.test(sql)) return { rows: [{ gasto: 0 }] };
    return { rows: [] };
  };
  const app = express();
  app.use('/hub/relatorios', require('../relatorios').router);
  srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  base = 'http://127.0.0.1:' + srv.address().port + '/hub/relatorios/produtividade';
});
test.after(() => srv.close());
const pedir = (rota, tok, corpo) => fetchReal(base + rota, {
  method: corpo ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Auth-Token': tok || '' }, body: corpo ? JSON.stringify(corpo) : undefined
}).then(async r => ({ status: r.status, corpo: await r.json().catch(() => ({})) }));

test('só o Tabelião: escrevente recebe 403 e sem sessão 401', async () => {
  assert.equal((await pedir('', 'tok-lara')).status, 403);
  assert.equal((await pedir('')).status, 401);
  assert.equal((await pedir('/mes', 'tok-lara', { ano: 2026, mes: 9, dados: INICIAL[2].dados })).status, 403);
});

test('lista, dias úteis, gravação, configuração e exclusão', async () => {
  const l = await pedir('', 'tok-cesar');
  assert.equal(l.status, 200);
  assert.deepEqual(l.corpo.meses.map(m => m.chave), ['2026-06', '2026-07', '2026-08']);
  assert.equal(l.corpo.nomes['lara.silva'], 'Lara');
  assert.ok(l.corpo.tabeliaes.includes('cesar.bravo'));
  assert.deepEqual(l.corpo.config, P.CONFIG_PADRAO);
  assert.equal((await pedir('/dias-uteis?mes=2026-09', 'tok-cesar')).corpo.dias_uteis, 21);
  assert.equal((await pedir('/dias-uteis?mes=setembro', 'tok-cesar')).status, 400);

  const setembro = Object.assign(clone(INICIAL[2].dados), { diasUteis: 21 });
  const g = await pedir('/mes', 'tok-cesar', { ano: 2026, mes: 9, dados: setembro, fonte: 'teste' });
  assert.equal(g.status, 200);
  assert.equal(g.corpo.chave, '2026-09');
  assert.equal(banco.gravacoes.at(-1)[4], 'cesar.bravo');
  assert.equal((await pedir('/mes', 'tok-cesar', { ano: 2026, mes: 13, dados: setembro })).status, 400);
  const ruim = await pedir('/mes', 'tok-cesar', { ano: 2026, mes: 9, dados: Object.assign(clone(setembro), { total: 'x' }) });
  assert.equal(ruim.status, 400);
  assert.match(ruim.corpo.erro, /total do mês inválido/);

  assert.equal((await pedir('/config', 'tok-cesar', { corte: 300, ferd: 16.6667, ir: 27.5 })).corpo.config.corte, 300);
  assert.equal((await pedir('/config', 'tok-cesar', { corte: 0, ferd: 10, ir: 10 })).status, 400);

  assert.equal((await pedir('/apagar', 'tok-cesar', { ano: 2026, mes: 9 })).status, 200);
  assert.equal((await pedir('/apagar', 'tok-cesar', { ano: 2026, mes: 9 })).status, 404);
});

test('análise da IA: dados só somados no prompt, resposta guardada no mês', async () => {
  const antes = { fetch: global.fetch, chave: process.env.GEMINI_API_KEY };
  let prompt = '';
  const resposta = { resumo: 'Agosto fechou estável.', pessoas: [{ id: 'LARA.SILVA', texto: 'Liderou a mesa.' }],
    observacoes: ['Concentração alta na mesa.'], alertas: [{ titulo: 'Forma vazia', detalhe: 'R$ 282 mil sem forma informada.', nivel: 'atencao' }] };
  global.fetch = async (url, op) => {
    prompt = op.body;
    return { ok: true, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify(resposta) + '\n```' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 300 } }) };
  };
  process.env.GEMINI_API_KEY = 'teste';
  try {
    const r = await pedir('/analisar', 'tok-cesar', { ano: 2026, mes: 8 });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    assert.equal(r.corpo.analise.resumo, 'Agosto fechou estável.');
    assert.equal(r.corpo.analise.comparado_com, '2026-07');
    assert.equal(banco.meses.get('2026-8').analise.alertas[0].nivel, 'atencao');
    assert.match(prompt, /NÚMEROS DO MÊS \[[0-9A-F]{8}\]/);   // bloco de dados com código (ia-defesa)
    assert.match(prompt, /REGRA DE SEGURANÇA DO SERVIDOR/);
    assert.match(prompt, /mesa de escrituras/);
    assert.equal((await pedir('/analisar', 'tok-cesar', { ano: 2025, mes: 1 })).status, 404);
  } finally {
    global.fetch = antes.fetch;
    if (antes.chave === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = antes.chave;
  }
});
