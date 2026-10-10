'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../receita-liquida');
const P = require('../produtividade');
const original = () => ({ v: 1, total: 1000, atos: 10, mediana: 50, diasUteis: 20,
  pessoas: [{ id: 'a', atos: 2, total: 600, mediana: 300, max: 400 }, { id: 'b', atos: 8, total: 400, mediana: 50, max: 60 }],
  pgto: [{ forma: 'PIX', qtd: 8, total: 800 }, { forma: 'Outros', qtd: 2, total: 200 }],
  faixas: null, serie: { dias: ['2026-10-01', '2026-10-02'], total: [250, 750], porPessoa: { a: [100, 500], b: [150, 250] } } });
const sum = vs => vs.reduce((s, v) => s + R.centavos(v), 0);
test('regra exata em centavos preserva bruto e subtrai repasses uma única vez', () => {
  assert.deepEqual(R.financeiro(1000).centavos, { bruto: 100000, repasses: 29569, receita_liquida: 70431 });
  assert.equal(R.financeiro(1000000).receita_liquida, 704306);
  assert.equal(R.financeiro(-1000).receita_liquida, -704.31);
  const d = original(), antes = JSON.stringify(d), x = R.projetar(d);
  assert.equal(JSON.stringify(d), antes); assert.equal(x.financeiro.percentual_repasses, 29.5694);
  assert.equal(x.financeiro.base_individual, 'usuario_financeiro');
  assert.equal(x.financeiro.receita_por_autor.status, 'pendente_vinculo_financeiro_por_ato');
  assert.equal(x.financeiro.receita_por_autor.total_atribuido, null);
  assert.equal(x.dados_liquidos.atos, 10); assert.equal(x.dados_liquidos.diasUteis, 20);
  assert.equal(x.dados_liquidos.pessoas[0].total_bruto, 600);
  assert.throws(() => R.projetar(x.dados_liquidos), /brutos originais/);
  assert.throws(() => P.validarDados(x.dados_liquidos), /projeção líquida/);
});
test('grupos e matriz completos reconciliam centavos sem alterar quantidades', () => {
  const d = R.projetar(original()).dados_liquidos;
  assert.equal(sum(d.pessoas.map(p => p.total)), R.centavos(d.total));
  assert.equal(sum(d.pgto.map(p => p.total)), R.centavos(d.total));
  assert.equal(sum(d.serie.total), R.centavos(d.total));
  for (const p of d.pessoas) assert.equal(sum(d.serie.porPessoa[p.id]), R.centavos(p.total));
  d.serie.total.forEach((v, i) => assert.equal(sum(Object.values(d.serie.porPessoa).map(a => a[i])), R.centavos(v)));
  assert.deepEqual(d.pgto.map(p => p.qtd), [8, 2]);
  const vals = R.distribuir([1, 1, 1], R.proporcao(3)); assert.equal(vals.reduce((a, b) => a + b), 2);
  assert.deepEqual(R.distribuir([-1, 1], 0), [-1, 1]);
});
test('grupos incompletos e séries parciais mantêm lacunas visíveis', () => {
  const d = original(); d.pgto.pop(); delete d.serie.porPessoa.b;
  const p = R.projetar(d);
  assert.equal(p.dados_liquidos.pgto.length, 1);
  assert.equal(p.dados_liquidos.pgto[0].total, 563.44);
  assert.ok(p.financeiro.notas.some(n => n.grupo === 'pgto' && n.codigo === 'GRUPO_NAO_RECONCILIADO'));
  assert.ok(p.financeiro.notas.some(n => n.codigo === 'MATRIZ_PARCIAL'));
});
test('perfis usam ticket bruto, IA recebe líquido e análises antigas ficam históricas', () => {
  const dados = original(), row = { ano: 2026, mes: 10, chave: '2026-10', dados, analise: { resumo: 'Base antiga' }, analise_em: '2026-10-09' };
  const m = P.linhaMes(row);
  assert.deepEqual(m.dados, dados); assert.equal(m.analise, null);
  assert.equal(m.analise_status, 'anterior_base_obsoleta'); assert.equal(m.analise_historica.analise.resumo, 'Base antiga');
  const pacote = P.resumoParaIA(row, null, {}, { corte: 250 });
  assert.equal(pacote.total, 704.31); assert.equal(pacote.pessoas[0].perfil, 'mesa de escrituras');
  assert.equal(pacote.pessoas[0].total, 422.59); assert.match(pacote.base_receita, /sem despesas ou IR/);
  assert.equal(P.perfilDe({ id: 'a', atos: 2, total: 422.59, total_bruto: 600 }, 250), 'mesa de escrituras');
});
