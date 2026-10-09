'use strict';
// Taxonomia de leitura: somente rótulos explícitos da exportação. Não altera os
// originais, não usa nomes de clientes, usuários de cadastro ou tipos do Trello.
const VERSAO = 'extra-digital-tipos-v1';
const NOMES = Object.freeze({
  compra_venda: 'Compra e venda', inventario_partilha: 'Inventário e partilha',
  cessao_posse: 'Cessão de direitos possessórios', cessao_heranca: 'Cessão de direitos hereditários',
  doacao: 'Doação', uniao_estavel: 'União estável', dissolucao_uniao: 'Dissolução de união estável',
  separacao_divorcio: 'Separação / divórcio', pacto_antenupcial: 'Pacto antenupcial',
  emancipacao: 'Emancipação', ata_notarial: 'Ata notarial', rerratificacao: 'Retificação / rerratificação',
  revogacao: 'Revogação', declaratoria: 'Declaração', permuta: 'Permuta',
  renuncia_heranca: 'Renúncia de herança', distrato: 'Distrato',
  cancelamento_hipoteca: 'Cancelamento de hipoteca', diretivas_vontade: 'Diretivas antecipadas de vontade',
  nao_classificado: 'Tipo não identificado na fonte'
});
const normalizar = valor => typeof valor === 'string' ? valor.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toUpperCase() : '';
const SUBTIPOS = Object.freeze({
  'ESCRITURA DE INVENTARIO': 'inventario_partilha',
  'ESCR. SEM VALOR: SEPARACAO/DIVORCIO': 'separacao_divorcio',
  'ATA NOTARIAL': 'ata_notarial',
  'ESCRITURA DE RERRATIFICACAO SEM VALOR': 'rerratificacao',
  'REVOGACAO': 'revogacao'
});
// A primeira expressão descreve o ato principal, não um ato citado depois dele.
// Não há correção aproximada de grafia nem interpretação de "com/sem valor".
const REGRAS = [
  ['rerratificacao', /^(?:RERRATIFICACAO|RERATIFICACAO|RETIFICACAO|RATIFICACAO|RERRAT)(?:\b|[-:])/],
  ['revogacao', /^REVOGACAO\b/],
  ['dissolucao_uniao', /^DISSOLUCAO (?:DE )?UNIAO ESTAVEL\b/],
  ['separacao_divorcio', /^(?:SEPARACAO|DIVORCIO)\b/],
  ['inventario_partilha', /^(?:INVENTARIO\b|INV(?:$|[\s-]))/],
  ['compra_venda', /^(?:COMPRA E VENDA\b|CV(?:$|[\s-]))/],
  ['cessao_posse', /^(?:CESSAO (?:DE )?(?:DIREITOS? )?(?:DE )?(?:POSSE|POSSESSORIOS?)\b|CDP(?:$|[\s-]))/],
  ['cessao_heranca', /^(?:CESSAO (?:DE )?(?:DIREITOS? )?(?:HEREDITARIOS?|HERANCA)\b|CDH(?:$|[\s-]))/],
  ['doacao', /^(?:DOACAO\b|DOA(?:$|[\s-]))/],
  ['uniao_estavel', /^(?:(?:DECLARACAO|DECLARATORIA) DE )?UNIAO ESTAVEL\b/],
  ['pacto_antenupcial', /^PACTO ANTENUPCIAL\b/],
  ['emancipacao', /^EMANCIPACAO\b/],
  ['ata_notarial', /^(?:ATA NOTARIAL\b|ATA(?:$|[\s-]))/],
  ['permuta', /^PERMUTAS?\b/],
  ['renuncia_heranca', /^RENUNCIA (?:DE )?HERANCA\b/],
  ['distrato', /^DISTRATO\b/],
  ['cancelamento_hipoteca', /^CANCELAMENTO DE HIPOTECA\b/],
  ['diretivas_vontade', /^(?:DIRETIVAS ANTECIPADAS DE VONTADE\b|DAV(?:$|[\s-]))/],
  ['declaratoria', /^(?:DECLARATORIA|DECLARACAO)\b/]
];
function classificar({ subtipo, finalidade } = {}) {
  const estruturado = SUBTIPOS[normalizar(subtipo)];
  const explicito = REGRAS.find(([, re]) => re.test(normalizar(finalidade)))?.[0];
  if (estruturado && explicito && estruturado !== explicito) return { codigo: 'nao_classificado', origem: null, divergente: true };
  if (estruturado) return { codigo: estruturado, origem: 'Sub-tipo', divergente: false };
  if (explicito) return { codigo: explicito, origem: 'Finalidade', divergente: false };
  return { codigo: 'nao_classificado', origem: null, divergente: false };
}
function distribuir(grupos, completo) {
  const totais = new Map();
  const classificacao = { versao: VERSAO, campos: ['Sub-tipo', 'Finalidade'], nao_classificados: 0, divergentes: 0, por_subtipo: 0, por_finalidade: 0 };
  for (const grupo of grupos) {
    const c = classificar(grupo), n = grupo.total;
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('contagem de tipos inválida');
    totais.set(c.codigo, (totais.get(c.codigo) || 0) + n);
    if (c.codigo === 'nao_classificado') classificacao.nao_classificados += n;
    if (c.divergente) classificacao.divergentes += n;
    if (c.origem === 'Sub-tipo') classificacao.por_subtipo += n;
    if (c.origem === 'Finalidade') classificacao.por_finalidade += n;
  }
  const tipos = [...totais].map(([codigo, total_observado]) => ({ codigo, nome: NOMES[codigo], total_observado, total_oficial: completo ? total_observado : null }))
    .sort((a, b) => b.total_observado - a.total_observado || a.codigo.localeCompare(b.codigo));
  return { tipos, classificacao };
}
module.exports = { VERSAO, classificar, distribuir };
