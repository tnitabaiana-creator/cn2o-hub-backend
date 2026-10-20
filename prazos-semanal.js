'use strict';
// Projeção de leitura do relógio existente. Não inicializa tabelas, consulta o
// Trello, recalcula vencimentos ou altera responsáveis.
const cal = require('./horas-uteis');
const VERSAO = 'prazos-semanal-v1';
const MAX_LINHAS = 100000, MINUTOS_DESATUALIZADO = 30;
const erro = (status, codigo, message) => Object.assign(new Error(message), { status, codigo });
function escalar(q, k, padrao = '') {
  const v = q[k] === undefined ? padrao : q[k];
  if (typeof v !== 'string') throw erro(400, 'FILTRO_INVALIDO', `Filtro ${k} inválido.`);
  return v;
}
function numero(q, k, padrao, max) {
  const v = escalar(q, k, String(padrao));
  if (!/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(+v) || +v > max)
    throw erro(400, 'FILTRO_INVALIDO', `Filtro ${k} fora do limite.`);
  return +v;
}
function pedido(query = {}, agora = new Date()) {
  const ref = escalar(query, 'ref', cal.local(agora).data);
  if (!/^(20\d{2})-\d{2}-\d{2}$/.test(ref) || !Number.isFinite(Date.parse(ref + 'T12:00:00Z')) ||
      new Date(ref + 'T12:00:00Z').toISOString().slice(0, 10) !== ref)
    throw erro(400, 'DATA_INVALIDA', 'Informe uma data válida entre 2000 e 2099.');
  const inicio = cal.somaDias(ref, -((new Date(ref + 'T12:00:00Z').getUTCDay() + 6) % 7));
  const responsavel = escalar(query, 'responsavel'), tipo = escalar(query, 'tipo');
  const situacao = escalar(query, 'situacao', 'todos');
  if (responsavel && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(responsavel))
    throw erro(400, 'FILTRO_INVALIDO', 'Responsável deve ser um login exato.');
  if (tipo.length > 80 || /[\x00-\x1f\x7f]/.test(tipo) ||
      !['todos', 'vencidos', 'a_vencer', 'concluidos'].includes(situacao))
    throw erro(400, 'FILTRO_INVALIDO', 'Tipo ou situação inválidos.');
  return { ref, inicio, fim: cal.somaDias(inicio, 6), responsavel, tipo, situacao,
    pagina_fila: numero(query, 'pagina_fila', 1, 100000),
    pagina_conclusoes: numero(query, 'pagina_conclusoes', 1, 100000),
    limite: numero(query, 'limite', 50, 100) };
}
const iso = v => v == null ? null : Number.isFinite(new Date(v).getTime()) ? new Date(v).toISOString() : null;
const arredondar = n => Math.round(n * 100) / 100;
const url = v => /^https:\/\/trello\.com\/c\/[a-zA-Z0-9]+(?:\/[^\s]*)?$/.test(v || '') ? v : null;
function base(row) {
  const inicio = iso(row.inicio), vencimento = iso(row.vencimento);
  if (!inicio || !vencimento || vencimento < inicio)
    throw erro(503, 'FONTE_INCONSISTENTE', 'Há um relógio com datas inconsistentes. Os dados não foram alterados.');
  const responsavel = row.responsavel_login || null;
  return { card_id: row.card_id, protocolo: row.protocolo, ato: row.ato || row.regra?.ato || 'Não informado',
    responsavel, responsavel_nome: responsavel ? row.responsavel_nome || responsavel : 'Sem responsável',
    inicio, vencimento, trello_url: url(row.card_url) };
}
function filaItem(row, corte) {
  const b = base(row), confirmado = iso(row.confirmado_em);
  const motivos = [];
  if (row.estado === 'inacessivel') motivos.push('cartao_inacessivel');
  if (row.erro) motivos.push('erro_sincronizacao');
  if (!confirmado) motivos.push('sem_confirmacao');
  else if (Date.parse(confirmado) > Date.parse(corte)) motivos.push('confirmacao_temporal_invalida');
  else if (Date.parse(corte) - Date.parse(confirmado) > MINUTOS_DESATUALIZADO * 60000) motivos.push('confirmacao_desatualizada');
  const vencido = Date.parse(b.vencimento) < Date.parse(corte);
  return { ...b, situacao: vencido ? 'vencido' : 'a_vencer', estado_origem: row.estado,
    confirmado_em: confirmado, sincronizacao_pendente: motivos.length > 0, pendencias: motivos,
    regra: row.regra ? { dias: row.regra.dias ?? null, uteis: row.regra.uteis ?? null, versao: row.regra.versao || null } : null,
    atraso_horas_uteis: vencido ? arredondar(cal.horasUteis(b.vencimento, corte)) : 0,
    atraso_horas_corridas: vencido ? arredondar((Date.parse(corte) - Date.parse(b.vencimento)) / 3600000) : 0 };
}
function conclusaoItem(row) {
  const b = base(row), concluido = iso(row.concluido_em);
  if (!concluido || concluido < b.inicio || typeof row.evidencia !== 'string' || !row.evidencia.trim() ||
      !Number.isFinite(Number(row.atraso_horas_uteis)) || Number(row.atraso_horas_uteis) < 0 ||
      !Number.isFinite(Number(row.horas_uteis)) || Number(row.horas_uteis) < 0 ||
      typeof row.no_prazo !== 'boolean' || row.no_prazo !== (Date.parse(concluido) <= Date.parse(b.vencimento)))
    throw erro(503, 'FONTE_INCONSISTENTE', 'Uma conclusão operacional precisa de conferência da evidência registrada.');
  return { ...b, situacao: 'concluido', concluido_em: concluido, no_prazo: row.no_prazo,
    atraso_horas_uteis: Number(row.atraso_horas_uteis),
    atraso_horas_corridas: arredondar(Math.max(0, Date.parse(concluido) - Date.parse(b.vencimento)) / 3600000),
    horas_uteis: Number(row.horas_uteis), evidencia: row.evidencia,
    confirmado_em: iso(row.registrado_em), sincronizacao_pendente: false };
}
function resumo(itens) {
  const r = { vencidos: 0, a_vencer: 0, concluidos: 0, sem_responsavel: 0,
    concluidos_no_prazo: 0, concluidos_atrasados: 0 };
  for (const i of itens) {
    r[i.situacao === 'vencido' ? 'vencidos' : i.situacao === 'concluido' ? 'concluidos' : 'a_vencer']++;
    if (!i.responsavel) r.sem_responsavel++;
    if (i.situacao === 'concluido') r[i.no_prazo ? 'concluidos_no_prazo' : 'concluidos_atrasados']++;
  }
  return r;
}
function paginar(itens, pagina, limite, integral) {
  return { total: itens.length, pagina, limite, paginas: Math.ceil(itens.length / limite),
    itens: integral ? itens : itens.slice((pagina - 1) * limite, pagina * limite) };
}
function montar({ fila, conclusoes, corte }, p, integral = false) {
  if (!iso(corte)) throw erro(503, 'CORTE_INDISPONIVEL', 'Não foi possível confirmar o instante da consulta.');
  const ini = cal.meiaNoiteLocal(p.inicio).getTime(), fim = cal.meiaNoiteLocal(cal.somaDias(p.fim, 1)).getTime();
  const atuais = fila.filter(r => ['ativo', 'assinatura', 'inacessivel'].includes(r.estado))
    .map(r => filaItem(r, corte)).filter(i => i.situacao === 'vencido' || (Date.parse(i.vencimento) >= ini && Date.parse(i.vencimento) < fim))
    .sort((a, b) => a.vencimento.localeCompare(b.vencimento) || a.card_id.localeCompare(b.card_id));
  const entregas = conclusoes.filter(r => r.tipo === 'ato' && Date.parse(r.concluido_em) >= ini && Date.parse(r.concluido_em) < fim && Date.parse(r.concluido_em) <= Date.parse(corte))
    .map(conclusaoItem).sort((a, b) => a.concluido_em.localeCompare(b.concluido_em) || a.card_id.localeCompare(b.card_id));
  if (new Set(atuais.map(i => i.card_id)).size !== atuais.length || new Set(entregas.map(i => i.card_id)).size !== entregas.length)
    throw erro(503, 'FONTE_INCONSISTENTE', 'Há cartões duplicados na fonte operacional; a consulta precisa de conferência.');
  const todos = [...atuais, ...entregas];
  const pessoas = new Map(todos.map(i => [i.responsavel, i.responsavel_nome]));
  const filtrar = i => (!p.responsavel || (p.responsavel === 'sem_responsavel' ? !i.responsavel : i.responsavel === p.responsavel)) && (!p.tipo || i.ato === p.tipo);
  const filtrados = todos.filter(filtrar), grupos = new Map();
  for (const i of filtrados) {
    if (!grupos.has(i.responsavel)) grupos.set(i.responsavel, []);
    grupos.get(i.responsavel).push(i);
  }
  const filaFiltrada = atuais.filter(filtrar).filter(i => p.situacao === 'todos' || (p.situacao === 'vencidos' ? i.situacao === 'vencido' : p.situacao === 'a_vencer' && i.situacao === 'a_vencer'));
  const entregasFiltradas = ['todos', 'concluidos'].includes(p.situacao) ? entregas.filter(filtrar) : [];
  return { versao: VERSAO, corte_em: iso(corte), semana: { inicio: p.inicio, fim: p.fim },
    filtros: { ref: p.ref, responsavel: p.responsavel || null, situacao: p.situacao, tipo: p.tipo || null },
    resumo: resumo(filtrados),
    por_responsavel: [...grupos].map(([login, itens]) => ({ login, nome: pessoas.get(login), ...resumo(itens) }))
      .sort((a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR') || String(a.login).localeCompare(String(b.login))),
    responsaveis: [...pessoas].map(([login, nome]) => ({ login, nome })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
    tipos: [...new Set(todos.map(i => i.ato))].sort(),
    fila: paginar(filaFiltrada, p.pagina_fila, p.limite, integral),
    conclusoes: paginar(entregasFiltradas, p.pagina_conclusoes, p.limite, integral),
    criterios: {
      fila: 'Fila atual no corte da consulta: todos os vencidos acumulados e os prazos ainda a vencer na semana selecionada. Início e vencimento preservados do Relógio do Ato.',
      conclusoes: 'Conclusão operacional comprovada no Trello dentro da semana, pelo primeiro encerramento registrado por cartão. Não equivale à lavratura registrada no Extra Digital.',
      responsavel: 'Responsável operacional já identificado no relógio; o nome não é inferido do Criado Por do Extra Digital. As conclusões preservam o responsável registrado no encerramento.'
    },
    cobertura: {
      reconstrucao_historica: false, estado: todos.length ? 'registros_observados' : 'sem_registros_observados',
      confirmacao_desatualizada_apos_minutos: MINUTOS_DESATUALIZADO,
      pendencias_sincronizacao: atuais.filter(i => i.sincronizacao_pendente).length,
      criterio: 'Somente relógios e conclusões já registrados. Ausência de amostra não significa inexistência de trabalho nem cumprimento de 100%.',
      observacao: 'A fila é atual, mesmo ao selecionar uma semana anterior. Um cartão reaberto pode aparecer na fila e também em sua conclusão anterior; esses totais são distintos.'
    } };
}
async function consultar(pool, query = {}, { integral = false } = {}) {
  const p = pedido(query);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const corte = (await client.query('SELECT transaction_timestamp() AS corte')).rows[0]?.corte;
    const fila = await client.query(`SELECT a.card_id,a.protocolo,a.inicio,a.vencimento,a.regra,a.estado,a.responsavel_login,
      a.card_url,a.confirmado_em,a.erro,u.nome AS responsavel_nome
      FROM prazos_atos a LEFT JOIN usuarios u ON u.login=a.responsavel_login
      WHERE a.estado IN ('ativo','assinatura','inacessivel') ORDER BY a.vencimento,a.card_id LIMIT $1`, [MAX_LINHAS + 1]);
    const conclusoes = await client.query(`SELECT m.*,a.card_url,u.nome AS responsavel_nome
      FROM prazos_metricas m LEFT JOIN prazos_atos a ON a.card_id=m.card_id
      LEFT JOIN usuarios u ON u.login=m.responsavel_login
      WHERE m.tipo='ato' AND m.concluido_em >= $1 AND m.concluido_em < $2 AND m.concluido_em <= $3
      ORDER BY m.concluido_em,m.card_id LIMIT $4`,
    [cal.meiaNoiteLocal(p.inicio), cal.meiaNoiteLocal(cal.somaDias(p.fim, 1)), corte, MAX_LINHAS + 1]);
    if (fila.rows.length > MAX_LINHAS || conclusoes.rows.length > MAX_LINHAS)
      throw erro(503, 'LIMITE_DA_FONTE', 'Fonte excede o limite seguro da consulta; nenhum total parcial foi apresentado.');
    const resultado = montar({ fila: fila.rows, conclusoes: conclusoes.rows, corte }, p, integral);
    await client.query('COMMIT');
    return resultado;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.status) throw e;
    throw erro(503, e.code === '42P01' ? 'FONTE_AUSENTE' : 'FONTE_INDISPONIVEL',
      'Fonte de prazos indisponível. Não foi possível confirmar os totais; tente novamente.');
  } finally { client.release(); }
}
function csv(r) {
  const cel = v => '"' + String(v == null ? '' : v).replace(/^[\s]*[=+@-]/, "'$&").replace(/"/g, '""') + '"';
  const linhas = [['Relatório semanal de prazos operacionais'], ['Semana', r.semana.inicio, r.semana.fim], ['Corte da consulta', r.corte_em],
    ['Fila atual', r.criterios.fila], ['Conclusões', r.criterios.conclusoes],
    ['Responsável', r.criterios.responsavel], ['Cobertura', r.cobertura.criterio], ['Observação', r.cobertura.observacao],
    ['Situação', 'Protocolo', 'Tipo', 'Responsável', 'Login', 'Início original', 'Vencimento original', 'Conclusão operacional', 'No prazo',
      'Atraso em horas úteis', 'Atraso em horas corridas', 'Sincronização pendente', 'Cartão']];
  for (const i of [...r.fila.itens, ...r.conclusoes.itens]) linhas.push([i.situacao, i.protocolo, i.ato, i.responsavel_nome, i.responsavel,
    i.inicio, i.vencimento, i.concluido_em, i.no_prazo === undefined ? '' : i.no_prazo ? 'Sim' : 'Não',
    i.atraso_horas_uteis, i.atraso_horas_corridas, i.sincronizacao_pendente ? 'Sim' : 'Não', i.trello_url]);
  return '\uFEFF' + linhas.map(l => l.map(cel).join(';')).join('\r\n') + '\r\n';
}
module.exports = { VERSAO, pedido, montar, consultar, csv };
