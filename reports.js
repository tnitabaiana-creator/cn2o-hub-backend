// reports.js — motor de cálculo dos relatórios das escreventes.
//
// Funções puras: recebem as linhas já lidas do banco (conclusoes, pendencias,
// pesos_ato) e devolvem os números. Nada aqui lê banco, relógio ou Trello — é o que
// os testes unitários exercitam.
//
// Definições (todas em HORAS ÚTEIS, ver horas-uteis.js):
//   Tempo na mesa     entrada do cartão no quadro da escrevente → chegada ao Finalizado.
//   Custo pessoal     horas nas listas de trabalho DELA (Revisar Minuta + Ajuste/Retorno);
//                     conferência, pendência documental e assinatura não entram.
//   Referência        mediana do custo pessoal da EQUIPE naquele tipo de ato, nos
//                     últimos 90 dias (mín. 3 atos); sem isso, a referência de pesos_ato.
//   Índice de custo   mediana de (custo pessoal ÷ referência do tipo) dos atos dela no
//                     período. 1,00 = ritmo da equipe; 0,80 = 20% mais rápida.
//   Afinidade         referência da equipe ÷ mediana dela no tipo (90 dias, mín. 3 atos
//                     dela). Acima de 1 = rende mais que a equipe naquele ato.
//   Pontos            soma dos pesos (pesos_ato) dos atos concluídos.
//   Taxa de retorno   atos concluídos que passaram por Ajuste/Retorno ÷ atos concluídos.
// Só entram nas medianas os atos com histórico completo (entrada na mesa observada).
'use strict';

const AMOSTRA_MINIMA = 3;
const PISO_HORAS = 0.5;   // evita razão infinita quando o ato atravessou a lista em minutos

function percentil(valores, p) {
  const v = (valores || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * p;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
const mediana = v => percentil(v, 0.5);
const p75 = v => percentil(v, 0.75);
const r2 = n => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

function agrupar(lista, chave) {
  const m = new Map();
  for (const x of lista) {
    const k = typeof chave === 'function' ? chave(x) : x[chave];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
const completos = lista => lista.filter(c => c.historico_completo && Number.isFinite(c.horas_ativas));
const pesoDe = (pesos, tipo) => (pesos[tipo] && pesos[tipo].peso) || (pesos.OUTROS && pesos.OUTROS.peso) || 1;

// tipo → { horas, fonte: 'equipe' | 'tabela', n }
function referencias(janela, pesos) {
  const out = {};
  const porTipo = agrupar(completos(janela || []), 'tipo_ato');
  const tipos = new Set([...Object.keys(pesos || {}), ...porTipo.keys()]);
  for (const t of tipos) {
    const lista = porTipo.get(t) || [];
    if (lista.length >= AMOSTRA_MINIMA) {
      out[t] = { horas: mediana(lista.map(c => c.horas_ativas)), fonte: 'equipe', n: lista.length };
    } else {
      const tab = (pesos[t] || pesos.OUTROS || {}).horas_referencia || 4;
      out[t] = { horas: tab, fonte: 'tabela', n: lista.length };
    }
  }
  return out;
}
const refDe = (refs, tipo) => Math.max((refs[tipo] || refs.OUTROS || { horas: 4 }).horas, PISO_HORAS);

// Índice de custo pessoal de um conjunto de conclusões.
function indiceCusto(conclusoes, refs) {
  return mediana(completos(conclusoes).map(c => c.horas_ativas / refDe(refs, c.tipo_ato)));
}

// Afinidade por tipo, para uma escrevente (janela de 90 dias).
function afinidades(janelaDela, refs) {
  const out = [];
  for (const [tipo, lista] of agrupar(completos(janelaDela), 'tipo_ato')) {
    if (lista.length < AMOSTRA_MINIMA) continue;
    const med = mediana(lista.map(c => c.horas_ativas));
    out.push({ tipo, n: lista.length, mediana_ativa: r2(med), referencia: r2(refDe(refs, tipo)),
      indice: r2(refDe(refs, tipo) / Math.max(med, PISO_HORAS)) });
  }
  return out.sort((a, b) => b.indice - a.indice);
}

function resumoTempo(lista) {
  const c = completos(lista);
  return {
    n_tempo: c.length,
    mediana_mesa: r2(mediana(c.map(x => x.horas_mesa))),
    p75_mesa: r2(p75(c.map(x => x.horas_mesa))),
    mediana_ativa: r2(mediana(c.map(x => x.horas_ativas))),
    p75_ativa: r2(p75(c.map(x => x.horas_ativas)))
  };
}

// pendências: abertas no período, em aberto no fim do período, mediana das encerradas
function resumoPendencias(lista, inicio, fim) {
  const i = new Date(inicio).getTime(), f = new Date(fim).getTime();
  const t = v => (v == null ? null : new Date(v).getTime());
  const res = tipo => {
    const l = lista.filter(p => p.tipo === tipo);
    const encerradas = l.filter(p => t(p.fechada_em) != null && t(p.fechada_em) >= i && t(p.fechada_em) < f);
    return {
      abertas: l.filter(p => t(p.aberta_em) != null && t(p.aberta_em) >= i && t(p.aberta_em) < f).length,
      em_aberto: l.filter(p => (t(p.aberta_em) == null || t(p.aberta_em) < f) && (t(p.fechada_em) == null || t(p.fechada_em) >= f)).length,
      encerradas: encerradas.length,
      mediana_horas: r2(mediana(encerradas.map(p => p.horas_uteis)))
    };
  };
  return { documental: res('documental'), ajuste: res('ajuste') };
}

function variacao(atual, anterior) {
  if (!Number.isFinite(anterior) || anterior === 0) return null;
  return r2((atual - anterior) / anterior);
}

// Leitura curta e factual do período, para o e-mail.
function leitura(e) {
  const f = [];
  if (!e.concluidos) f.push('Sem atos concluídos no período.');
  if (Number.isFinite(e.indice_custo) && e.n_tempo >= AMOSTRA_MINIMA) {
    const pct = Math.round(Math.abs(1 - e.indice_custo) * 100);
    if (e.indice_custo <= 0.9) f.push(`Custo pessoal ${pct}% abaixo da referência da equipe.`);
    else if (e.indice_custo >= 1.1) f.push(`Custo pessoal ${pct}% acima da referência da equipe.`);
    else f.push('Custo pessoal no ritmo da equipe.');
  }
  if (e.concluidos >= AMOSTRA_MINIMA && e.taxa_retorno >= 0.3) {
    f.push(`${e.com_retorno} de ${e.concluidos} atos voltaram para ajuste.`);
  }
  if (e.pendencias.documental.em_aberto >= 3) f.push(`${e.pendencias.documental.em_aberto} pendências documentais em aberto.`);
  const forte = (e.afinidade || []).find(a => a.indice >= 1.1);
  if (forte) f.push(`Afinidade com ${forte.tipo} (${String(forte.indice).replace('.', ',')}×).`);
  return f.join(' ');
}

// Relatório completo.
// entrada: { tipo, periodo: { inicio, fim } (instantes; fim exclusivo), escreventes,
//            conclusoes, anteriores, janela, pendencias, pesos, wip? }
function calcular(entrada) {
  const { periodo, pesos = {} } = entrada;
  const conclusoes = entrada.conclusoes || [];
  const anteriores = entrada.anteriores || [];
  const janela = entrada.janela || [];
  const pendencias = entrada.pendencias || [];
  const refs = referencias(janela, pesos);
  const pontos = lista => r2(lista.reduce((s, c) => s + pesoDe(pesos, c.tipo_ato), 0));

  const escreventes = (entrada.escreventes || []).map(esc => {
    const minhas = conclusoes.filter(c => c.escrevente === esc.login);
    const antes = anteriores.filter(c => c.escrevente === esc.login);
    const comRetorno = minhas.filter(c => c.retornos > 0).length;
    const mix = [...agrupar(minhas, 'tipo_ato')].map(([tipo, l]) => ({ tipo, n: l.length }))
      .sort((a, b) => b.n - a.n || a.tipo.localeCompare(b.tipo));
    const e = {
      login: esc.login, nome: esc.nome,
      concluidos: minhas.length,
      concluidos_anterior: antes.length,
      variacao: variacao(minhas.length, antes.length),
      pontos: pontos(minhas),
      pontos_anterior: pontos(antes),
      ...resumoTempo(minhas),
      indice_custo: r2(indiceCusto(minhas, refs)),
      com_retorno: comRetorno,
      taxa_retorno: minhas.length ? r2(comRetorno / minhas.length) : null,
      reaberturas: minhas.reduce((s, c) => s + (c.reaberturas || 0), 0),
      pendencias: resumoPendencias(pendencias.filter(p => p.escrevente === esc.login), periodo.inicio, periodo.fim),
      mix,
      afinidade: afinidades(janela.filter(c => c.escrevente === esc.login), refs),
      wip: (entrada.wip && entrada.wip[esc.login]) || null
    };
    e.leitura = leitura(e);
    return e;
  });

  const comRetorno = conclusoes.filter(c => c.retornos > 0).length;
  const equipe = {
    concluidos: conclusoes.length,
    concluidos_anterior: anteriores.length,
    variacao: variacao(conclusoes.length, anteriores.length),
    pontos: pontos(conclusoes),
    pontos_anterior: pontos(anteriores),
    ...resumoTempo(conclusoes),
    com_retorno: comRetorno,
    taxa_retorno: conclusoes.length ? r2(comRetorno / conclusoes.length) : null,
    pendencias: resumoPendencias(pendencias, periodo.inicio, periodo.fim),
    sem_historico: conclusoes.filter(c => !c.historico_completo).length
  };

  const porTipo = [...agrupar(conclusoes, 'tipo_ato')].map(([tipo, l]) => ({
    tipo, descricao: (pesos[tipo] && pesos[tipo].descricao) || tipo, n: l.length,
    peso: pesoDe(pesos, tipo), ...resumoTempo(l),
    referencia: r2(refDe(refs, tipo)), fonte_referencia: (refs[tipo] || {}).fonte || 'tabela'
  })).sort((a, b) => b.n - a.n || a.tipo.localeCompare(b.tipo));

  return { tipo: entrada.tipo, periodo, equipe, escreventes, por_tipo: porTipo, referencias: refs };
}

module.exports = {
  percentil, mediana, p75, referencias, indiceCusto, afinidades, resumoPendencias, calcular,
  AMOSTRA_MINIMA, PISO_HORAS
};
