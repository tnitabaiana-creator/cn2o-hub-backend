'use strict';
const receita = require('./receita-liquida');

function competencias(inicio, fim) {
  for (const d of [inicio, fim]) {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d + 'T00:00:00Z')) || new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) !== d) throw new Error('período financeiro inválido');
  }
  if (fim < inicio || Date.parse(fim) - Date.parse(inicio) > 366 * 864e5) throw new Error('período financeiro inválido');
  const meses = [], d = new Date(inicio.slice(0, 7) + '-01T00:00:00Z');
  while (d.toISOString().slice(0, 10) <= fim) { meses.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() + 1); }
  return meses;
}
function vazio(mes, status) {
  return { mes, status, receita_liquida: null, receita_liquida_centavos: null, lancamentos: null,
    dias_uteis: null, media_dia_util: null, fonte: null, importado_em: null };
}
function projetarMes(mes, row) {
  if (!row) return vazio(mes, 'ausente');
  try {
    if (!row.dados || row.dados.base_receita === 'liquida_apos_repasses' || row.dados.versao_financeira) throw new Error('fonte não bruta');
    const f = receita.financeiro(row.dados.total);
    const dias = Number.isSafeInteger(row.dados.diasUteis) && row.dados.diasUteis > 0 && row.dados.diasUteis <= 31 ? row.dados.diasUteis : null;
    const lancamentos = Number.isSafeInteger(row.dados.atos) && row.dados.atos >= 0 ? row.dados.atos : null;
    // Arredonda a média em centavos pela mesma regra simétrica do total canônico.
    const media = dias ? receita.reais(receita.proporcao(f.centavos.receita_liquida, 1n, BigInt(dias))) : null;
    return { mes, status: 'disponivel', receita_liquida: f.receita_liquida, receita_liquida_centavos: f.centavos.receita_liquida,
      lancamentos, dias_uteis: dias, media_dia_util: media, fonte: row.fonte || null, importado_em: row.importado_em || null };
  } catch { return vazio(mes, 'indisponivel'); }
}
async function consultar(pool, inicio, fim) {
  const meses = competencias(inicio, fim);
  const base = { escopo: 'competencias_mensais', base_individual: 'usuario_financeiro', criterio: receita.CRITERIO,
    periodo_relatorio: { inicio, fim }, receita_por_autor: receita.receitaPorAutor() };
  let rows;
  try {
    rows = (await pool.query(`SELECT ano,mes,dados,fonte,importado_em FROM produtividade_mes
      WHERE (ano::text || '-' || lpad(mes::text,2,'0'))=ANY($1::text[]) ORDER BY ano,mes`, [meses])).rows;
  } catch { return { ...base, competencias: meses.map(m => vazio(m, 'indisponivel')) }; }
  const fontes = new Map(rows.map(r => [`${r.ano}-${String(r.mes).padStart(2, '0')}`, r]));
  return { ...base, competencias: meses.map(m => projetarMes(m, fontes.get(m))) };
}
module.exports = { competencias, projetarMes, consultar };
