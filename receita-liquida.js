'use strict';
// Regra gerencial definida pelo titular. Não altera a receita bruta de origem.
const VERSAO = 'receita-liquida-2026-10-v1';
const PERCENTUAL_REPASSES = 29.5694;
const CRITERIO = 'Receita líquida do cartório: 70,4306% da receita bruta da Pesquisa de Produtividade, após 29,5694% de FERD e repasses; sem despesas ou IR.';
const DEN = 1000000n, NUM = 704306n;
function centavos(valor) {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) throw new Error('valor monetário inválido');
  const n = Math.round(valor * 100);
  if (!Number.isSafeInteger(n)) throw new Error('valor monetário excede o limite');
  return n;
}
function proporcao(n, num = NUM, den = DEN) {
  if (!Number.isSafeInteger(n)) throw new Error('centavos inválidos');
  const produto = BigInt(n) * num, sinal = produto < 0n ? -1n : 1n;
  return Number(sinal * ((sinal * produto + den / 2n) / den));
}
const reais = n => n / 100;
const converter = v => v == null ? null : reais(proporcao(centavos(v)));
const soma = vs => vs.reduce((a, b) => a + b, 0);
// Maiores restos, com piso matemático também para estornos negativos.
// Só reconcilia um grupo quando a própria fonte comprova sua soma.
function distribuir(valores, alvo) {
  const partes = valores.map((v, i) => {
    const p = BigInt(v) * NUM;
    let piso = p / DEN, resto = p % DEN;
    if (resto < 0n) { piso--; resto += DEN; }
    return { i, n: Number(piso), resto: Number(resto) };
  });
  const diferenca = alvo - soma(partes.map(x => x.n));
  if (diferenca < 0 || diferenca > partes.length) throw new Error('grupo monetário inconsistente');
  [...partes].sort((a, b) => b.resto - a.resto || a.i - b.i).slice(0, diferenca).forEach(p => p.n++);
  return partes.map(p => p.n);
}
function financeiro(bruto) {
  const b = centavos(bruto), liquido = proporcao(b), repasses = b - liquido;
  return { bruto: reais(b), repasses: reais(repasses), receita_liquida: reais(liquido),
    percentual_repasses: PERCENTUAL_REPASSES, criterio: CRITERIO, versao: VERSAO,
    centavos: { bruto: b, repasses, receita_liquida: liquido } };
}
function projetar(dados) {
  if (!dados || dados.base_receita === 'liquida_apos_repasses') throw new Error('a projeção exige os valores brutos originais');
  const d = JSON.parse(JSON.stringify(dados)), notas = [], f = financeiro(d.total);
  const bruto = f.centavos.bruto, liquido = f.centavos.receita_liquida;
  function grupo(lista, rotulo, totalBruto = bruto, totalLiquido = liquido) {
    const cents = lista.map(centavos), completo = soma(cents) === totalBruto;
    if (!completo) notas.push({ grupo: rotulo, codigo: 'GRUPO_NAO_RECONCILIADO', mensagem: 'A soma do grupo na fonte não coincide com o total; seus valores foram convertidos sem preencher diferenças.' });
    return (completo ? distribuir(cents, totalLiquido) : cents.map(v => proporcao(v))).map(reais);
  }
  d.total = f.receita_liquida; d.mediana = converter(d.mediana);
  const pessoas = grupo(d.pessoas.map(p => p.total), 'pessoas');
  d.pessoas.forEach((p, i) => { p.total_bruto = p.total; p.total = pessoas[i]; p.mediana = converter(p.mediana); p.max = converter(p.max); });
  for (const campo of ['pgto', 'faixas']) if (Array.isArray(d[campo])) {
    const valores = grupo(d[campo].map(x => x.total), campo);
    d[campo].forEach((x, i) => { x.total = valores[i]; });
  }
  if (Array.isArray(d.faixas)) notas.push({ grupo: 'faixas', codigo: 'LIMITES_BRUTOS_ORIGINAIS', mensagem: 'As faixas e quantidades seguem os limites brutos da fonte; os totais monetários exibidos são líquidos após repasses.' });
  if (d.serie) {
    const s = d.serie, original = dados.serie;
    s.total = grupo(original.total, 'serie.total');
    const ids = Object.keys(original.porPessoa || {});
    let matrizCompleta = ids.length === d.pessoas.length && soma(original.total.map(centavos)) === bruto;
    ids.forEach(id => {
      const p = d.pessoas.find(x => x.id === id), valores = original.porPessoa[id];
      const somaBruta = soma(valores.map(centavos));
      const coincide = !!p && somaBruta === centavos(p.total_bruto);
      if (!coincide) matrizCompleta = false;
      s.porPessoa[id] = grupo(valores, 'serie.porPessoa:' + id, coincide ? centavos(p.total_bruto) : somaBruta, coincide ? centavos(p.total) : proporcao(somaBruta));
    });
    if (matrizCompleta) matrizCompleta = original.total.every((v, i) => soma(ids.map(id => centavos(original.porPessoa[id][i]))) === centavos(v));
    if (matrizCompleta) s.total = original.total.map((_, i) => reais(soma(ids.map(id => centavos(s.porPessoa[id][i])))));
    else if (ids.length) notas.push({ grupo: 'serie.porPessoa', codigo: 'MATRIZ_PARCIAL', mensagem: 'As séries por pessoa não compõem integralmente a série mensal; a fonte foi preservada sem completar lacunas.' });
  }
  d.base_receita = 'liquida_apos_repasses'; d.versao_financeira = VERSAO;
  return { dados_liquidos: d, financeiro: { ...f, notas, arredondamento: 'Centavos inteiros; maiores restos nos grupos completos e séries reconciliadas por pessoa.' } };
}
module.exports = { VERSAO, PERCENTUAL_REPASSES, CRITERIO, centavos, reais, proporcao, distribuir, financeiro, projetar };
