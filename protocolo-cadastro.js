'use strict';

// Relatório observacional: somente leitura, independente da autoria/receita de escrituras.
const express = require('express');
const db = require('./db');
const cal = require('./horas-uteis');
const { extrairDoTitulo } = require('./tipos-ato');

const LISTAS = Object.freeze({
  digitalizacao: '692e04c90ddc9150fc7ee25c',
  cadastro: '693aafe273e4860efe413736',
  gerar_minuta: '6a52b82b6cd2fc065e6762bc'
});
const BOARDS = Object.freeze({ protocolo: '692e0379fa55156e778f27ef', tabeliao: '692e06a94b807c2a1816d992' });
const CRIACOES = new Set(['createCard', 'copyCard', 'emailCard', 'convertToCardFromCheckItem']);
const ms = value => value == null ? NaN : new Date(value).getTime();
const iso = value => Number.isFinite(ms(value)) ? new Date(value).toISOString() : null;
const r2 = n => n == null ? null : Math.round(n * 100) / 100;

function periodo(semana, agora = new Date()) {
  const data = String(semana || cal.local(agora).data);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || !Number.isFinite(Date.parse(data + 'T12:00:00Z')) ||
      new Date(data + 'T12:00:00Z').toISOString().slice(0, 10) !== data || +data.slice(0, 4) < 2020 || +data.slice(0, 4) > 2100) {
    throw Object.assign(new Error('semana deve ser uma data válida no formato AAAA-MM-DD'), { status: 400 });
  }
  const dia = new Date(data + 'T12:00:00Z').getUTCDay();
  const inicio = cal.somaDias(data, -((dia + 6) % 7));
  const fim = cal.somaDias(inicio, 6);
  const limite = cal.meiaNoiteLocal(cal.somaDias(fim, 1));
  if (cal.meiaNoiteLocal(inicio).getTime() > ms(agora)) {
    throw Object.assign(new Error('a semana ainda não começou'), { status: 400 });
  }
  return { inicio, fim, corte: new Date(Math.min(ms(agora), limite.getTime())).toISOString(), parcial: ms(agora) < limite.getTime() };
}

function chegada(ev) {
  const d = ev.dados || {};
  if (CRIACOES.has(ev.tipo) || ev.tipo === 'moveCardToBoard') return { board: d.board && d.board.id, lista: d.list && d.list.id };
  if (ev.tipo === 'updateCard' && d.listAfter) return { board: d.board && d.board.id, lista: d.listAfter.id };
  return null;
}
function saidaCadastro(ev) {
  const d = ev.dados || {};
  return (ev.tipo === 'updateCard' && d.listBefore && d.listBefore.id === LISTAS.cadastro && d.listAfter && d.listAfter.id !== LISTAS.cadastro && d.board && d.board.id === BOARDS.protocolo) ||
    (ev.tipo === 'moveCardFromBoard' && d.list && d.list.id === LISTAS.cadastro && d.board && d.board.id === BOARDS.protocolo);
}

// Posição observada é diferente de conclusão do setor. Fluxos históricos podem
// ter seguido direto à escrevente ou ao arquivo, sem passar por Gerar Minuta.
function posicao(ev) {
  const d = ev.dados || {}, destino = chegada(ev);
  if (destino) return { board: destino.board, lista: destino.lista,
    nome: (d.listAfter || d.list || {}).name || null, em: iso(ev.ocorrido_em), action_id: ev.action_id };
  if (ev.tipo === 'moveCardFromBoard') return { board: d.boardTarget && d.boardTarget.id,
    lista: null, nome: null, em: iso(ev.ocorrido_em), action_id: ev.action_id, saiu_do_quadro: true };
  return null;
}
function foraDoFluxo(p) {
  if (!p) return false;
  if (p.board && p.board !== BOARDS.protocolo) return true;
  if (!p.board && p.saiu_do_quadro) return true;
  const nome = String(p.nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  return /ARQUIV|SEM EFEITO|FINALIZAD/.test(nome);
}

// A passagem por conferência/pendências não pausa o prazo setorial nem apaga a entrada.
// A ausência da etapa Cadastro é apresentada; a política pode exigir sua comprovação.
function reconstruir(eventos, { corte, horasUteis = cal.horasUteis, exigirCadastro = false } = {}) {
  const vistos = new Set();
  const ordenados = eventos.filter(e => e && e.action_id && !vistos.has(e.action_id) && vistos.add(e.action_id))
    .filter(e => Number.isFinite(ms(e.ocorrido_em)) && ms(e.ocorrido_em) < ms(corte))
    .sort((a, b) => ms(a.ocorrido_em) - ms(b.ocorrido_em) ||
      (a.tipo === 'moveCardToBoard' ? 1 : 0) - (b.tipo === 'moveCardToBoard' ? 1 : 0) || String(a.action_id).localeCompare(String(b.action_id)));
  // As duas ações da MESMA transferência podem chegar invertidas e alguns ms separadas.
  // Casar por identidade, quadros de origem/destino e janela, nunca apenas proximidade.
  const pares = new Map(), fromUsados = new Set();
  const saidas = ordenados.filter(e => e.tipo === 'moveCardFromBoard' && e.dados && e.dados.board && e.dados.board.id === BOARDS.protocolo && e.dados.boardTarget && e.dados.boardTarget.id === BOARDS.tabeliao);
  for (const e of ordenados) {
    const d = e.dados || {};
    if (e.tipo !== 'moveCardToBoard' || !d.board || d.board.id !== BOARDS.tabeliao || !d.boardSource || d.boardSource.id !== BOARDS.protocolo) continue;
    const par = saidas.filter(s => s.card_id === e.card_id && !fromUsados.has(s.action_id) && Math.abs(ms(s.ocorrido_em) - ms(e.ocorrido_em)) <= 10000)
      .sort((a, b) => Math.abs(ms(a.ocorrido_em) - ms(e.ocorrido_em)) - Math.abs(ms(b.ocorrido_em) - ms(e.ocorrido_em)))[0];
    if (par) { pares.set(e.action_id, par); fromUsados.add(par.action_id); }
  }
  const ciclos = [], entradas = [];
  let ativo = null, terminou = 0, titulo = '', numero = null, short = null;
  const abrir = ev => {
    const c = { id: `${ev.card_id}:${ev.action_id}`, card_id: ev.card_id, protocolo: null, titulo: '', url: null,
      entrou_digitalizacao_em: null, saiu_cadastro_em: null, entrou_gerar_minuta_em: null,
      horas_uteis: null, status: 'em_andamento', no_prazo: null, retrabalho: terminou > 0, retornos: 0,
      action_entrada: null, action_saida: null, action_conclusao: null, cadastro_confirmado: false, motivo: null,
      fora_fluxo_em: null, finalizacao_nao_comprovada: false, ultima_posicao: null, saida_fluxo_observada: null };
    ciclos.push(c); ativo = c; return c;
  };
  for (const ev of ordenados) {
    const d = ev.dados || {}, card = d.card || {}, quando = iso(ev.ocorrido_em), destino = chegada(ev);
    if (card.name) titulo = String(card.name);
    if (card.shortLink && /^[a-zA-Z0-9]+$/.test(card.shortLink)) short = card.shortLink;
    if (ev.protocolo != null) numero = Number(ev.protocolo);
    if (fromUsados.has(ev.action_id)) continue;
    const par = pares.get(ev.action_id);
    if (par && saidaCadastro(par)) {
      if (!ativo) abrir(ev);
      ativo.saiu_cadastro_em = iso(par.ocorrido_em); ativo.action_saida = par.action_id; ativo.cadastro_confirmado = true;
    }
    if (destino && destino.board === BOARDS.protocolo && destino.lista === LISTAS.digitalizacao) {
      // Reordenação dentro da mesma lista não representa nova entrega física.
      if (!(ev.tipo === 'updateCard' && d.listBefore && d.listBefore.id === LISTAS.digitalizacao)) {
        entradas.push({ card_id: ev.card_id, ocorrido_em: quando, action_id: ev.action_id, retorno: !!(ativo && ativo.entrou_digitalizacao_em) });
        if (!ativo) abrir(ev); else if (ativo.entrou_digitalizacao_em) ativo.retornos++;
        if (!ativo.entrou_digitalizacao_em) { ativo.entrou_digitalizacao_em = quando; ativo.action_entrada = ev.action_id; }
      }
    }
    if (saidaCadastro(ev)) {
      if (!ativo) abrir(ev);
      ativo.saiu_cadastro_em = quando; ativo.action_saida = ev.action_id; ativo.cadastro_confirmado = true;
    }
    if (ativo) {
      const p = posicao(ev);
      if (p) {
        ativo.ultima_posicao = p;
        if (foraDoFluxo(p)) {
          if (!ativo.saida_fluxo_observada) ativo.saida_fluxo_observada = p;
        } else ativo.saida_fluxo_observada = null;
      }
    }
    const origem = d.boardSource && d.boardSource.id;
    const transferencia = ev.tipo === 'moveCardToBoard' && origem === BOARDS.protocolo && destino && destino.board === BOARDS.tabeliao;
    if (transferencia && !ativo) {
      // Uma transferência do setor pode ser o primeiro marco disponível. Manter
      // o início desconhecido permite reconhecer posterior Gerar sem inventá-lo.
      abrir(ev);
      ativo.ultima_posicao = posicao(ev);
      ativo.saida_fluxo_observada = ativo.ultima_posicao;
    }
    if (transferencia && ativo) ativo.transferencia_tabeliao_comprovada = true;
    if (destino && destino.board === BOARDS.tabeliao && destino.lista === LISTAS.gerar_minuta && ativo) {
      // Não aceitar uma chegada ao Tabelião originada de outro setor como entrega deste.
      if (transferencia || ativo.transferencia_tabeliao_comprovada) {
        ativo.entrou_gerar_minuta_em = quando; ativo.action_conclusao = ev.action_id;
        ativo.status = !exigirCadastro || ativo.cadastro_confirmado ? 'concluido' : 'pendente';
        if (!ativo.cadastro_confirmado) ativo.motivo = 'Entrega em Gerar Minuta observada, mas sem saída de Cadastro Extradigital comprovada no histórico.';
        if (!ativo.entrou_digitalizacao_em) ativo.motivo = 'Entrega ao Tabelião observada, mas a entrada em Digitalização não consta do histórico; duração desconhecida.';
        terminou++; ativo = null;
      }
    }
    if (ativo && (ev.tipo === 'deleteCard' || (ev.tipo === 'updateCard' && d.old && 'closed' in d.old && card.closed === true))) {
      ativo.status = 'interrompido'; ativo.motivo = 'Cartão arquivado ou excluído antes da entrega final comprovada.';
      ativo.interrompido_em = quando; ativo = null;
    }
  }
  for (const c of ciclos) {
    c.titulo = titulo || 'Cartão sem título no histórico';
    c.protocolo = Number.isFinite(numero) ? numero : (extrairDoTitulo(titulo).protocolo || null);
    c.url = short ? `https://trello.com/c/${short}` : `https://trello.com/c/${c.card_id}`;
    if (c.status === 'em_andamento' && foraDoFluxo(c.ultima_posicao)) {
      c.status = 'pendente'; c.finalizacao_nao_comprovada = true;
      c.fora_fluxo_em = (c.saida_fluxo_observada || c.ultima_posicao).em;
      c.motivo = 'Cartão fora da fila do setor, sem entrega em Gerar Minuta comprovada. Saída observada: ' + c.fora_fluxo_em +
        (c.ultima_posicao.nome ? '. Última posição: ' + c.ultima_posicao.nome : '') + '. Não compõe o estoque nem os atrasos do setor.';
    }
    const fim = c.entrou_gerar_minuta_em || c.interrompido_em || corte;
    const horas = c.entrou_digitalizacao_em && !c.finalizacao_nao_comprovada ? horasUteis(c.entrou_digitalizacao_em, fim) : null;
    c.horas_uteis = r2(horas);
    c.no_prazo = horas == null ? null : horas <= 8;
    if (!c.entrou_digitalizacao_em && !c.motivo) c.motivo = 'Entrada em Digitalização não observada; duração desconhecida.';
  }
  return { ciclos, entradas };
}

function calcular(eventos, { semana, agora = new Date(), exigirCadastro = false, calendario = cal.calendario } = {}) {
  const per = periodo(semana, agora), inicio = ms(cal.meiaNoiteLocal(per.inicio)), corte = ms(per.corte);
  const naSemana = t => ms(t) >= inicio && ms(t) < corte;
  const grupos = new Map();
  for (const ev of eventos) { if (!grupos.has(ev.card_id)) grupos.set(ev.card_id, []); grupos.get(ev.card_id).push(ev); }
  const todos = [], entradas = [];
  for (const evs of grupos.values()) {
    const r = reconstruir(evs, { corte: per.corte, horasUteis: calendario.horasUteis, exigirCadastro });
    todos.push(...r.ciclos); entradas.push(...r.entradas.filter(e => naSemana(e.ocorrido_em)));
  }
  const concluidos = todos.filter(c => c.status === 'concluido' && naSemana(c.entrou_gerar_minuta_em));
  const abertos = todos.filter(c => c.status === 'em_andamento');
  const pendentes = todos.filter(c => c.status === 'pendente' && naSemana(c.entrou_gerar_minuta_em || c.fora_fluxo_em));
  const pendenciasHistoricas = todos.filter(c => c.status === 'pendente' && c.finalizacao_nao_comprovada && ms(c.fora_fluxo_em) < inicio);
  const ciclos = todos.filter(c => naSemana(c.entrou_digitalizacao_em) || naSemana(c.entrou_gerar_minuta_em) || naSemana(c.fora_fluxo_em) || c.status === 'em_andamento');
  const tempos = concluidos.map(c => c.horas_uteis).filter(Number.isFinite).sort((a, b) => a - b);
  const mediana = tempos.length ? (tempos[Math.floor((tempos.length - 1) / 2)] + tempos[Math.ceil((tempos.length - 1) / 2)]) / 2 : null;
  const dias = Array.from({ length: 7 }, (_, i) => {
    const data = cal.somaDias(per.inicio, i), diaConclusoes = concluidos.filter(c => cal.local(c.entrou_gerar_minuta_em).data === data);
    const movimentos = entradas.filter(e => cal.local(e.ocorrido_em).data === data);
    return { data, dia_util: calendario.ehDiaUtil(data), entradas: movimentos.filter(e => !e.retorno).length,
      retornos_digitalizacao: movimentos.filter(e => e.retorno).length, entradas_movimentos_total: movimentos.length,
      concluidos: new Set(diaConclusoes.map(c => c.card_id)).size, ciclos_concluidos: diaConclusoes.length };
  });
  const faixas = calendario.faixas.map(([a, b]) => `${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}–${String(Math.floor(b / 60)).padStart(2, '0')}:${String(b % 60).padStart(2, '0')}`).join(', ');
  const observados = eventos.filter(e => ms(e.ocorrido_em) < corte && Number.isFinite(ms(e.ocorrido_em)));
  const datas = observados.map(e => ms(e.ocorrido_em)).sort((a, b) => a - b);
  const recebidos = observados.map(e => ms(e.recebido_em)).filter(Number.isFinite);
  const avisos = ['Resultados observados no histórico Trello disponível. A existência de eventos não comprova cobertura integral da semana.',
    'Meta setorial: 8 horas úteis desde Digitalização até Gerar Minuta. Conferência, pendências e retornos não pausam esse relógio.',
    'Conclusões contam cartões únicos na semana; ciclos, reentradas e retrabalho são apresentados separadamente.'];
  if (!observados.length) avisos.push('Nenhum histórico compatível disponível: ausência de dados não comprova produtividade zero.');
  if (concluidos.some(c => c.horas_uteis == null)) avisos.push('Há conclusões sem entrada conhecida; ficam fora das médias e da avaliação do prazo.');
  if (todos.some(c => c.entrou_gerar_minuta_em && !c.cadastro_confirmado)) avisos.push(exigirCadastro ? 'Entregas sem evidência da passagem pelo Cadastro ficam pendentes de conferência.' : 'Entregas sem evidência da passagem pelo Cadastro foram contadas com ressalva.');
  if (pendentes.some(c => c.finalizacao_nao_comprovada)) avisos.push('Há saídas para outros destinos sem entrega em Gerar Minuta comprovada. Ficam em conferência e não são contadas como fila, atraso ou conclusão do setor.');
  if (pendenciasHistoricas.length) avisos.push(`${pendenciasHistoricas.length} ciclo(s) histórico(s) já fora da fila antes desta semana, sem finalização setorial comprovada. Não compõem o estoque nem os atrasos atuais.`);
  return {
    periodo: per,
    criterio: { inicio: 'Em Digitalização', fim: 'Gerar Minuta', etapa_intermediaria: 'Cadastro Extradigital', meta_horas_uteis: 8,
      fuso: 'America/Sao_Paulo', expediente: faixas, feriados_extra: String(process.env.FERIADOS_EXTRA || '').split(',').map(s => s.trim()).filter(Boolean),
      exigir_cadastro: exigirCadastro, listas: LISTAS },
    resumo: { entradas: entradas.filter(e => !e.retorno).length,
      retornos_digitalizacao: entradas.filter(e => e.retorno).length, entradas_movimentos_total: entradas.length,
      protocolos_entrada_unicos: new Set(entradas.filter(e => !e.retorno).map(e => e.card_id)).size,
      concluidos: new Set(concluidos.map(c => c.card_id)).size, ciclos_concluidos: concluidos.length,
      retrabalhos: concluidos.filter(c => c.retrabalho).length, em_andamento: abertos.length,
      vencidos: abertos.filter(c => c.no_prazo === false).length, media_horas_uteis: tempos.length ? r2(tempos.reduce((a, b) => a + b, 0) / tempos.length) : null,
      mediana_horas_uteis: r2(mediana), no_prazo: concluidos.filter(c => c.no_prazo === true).length,
      fora_prazo: concluidos.filter(c => c.no_prazo === false).length, sem_tempo: concluidos.filter(c => c.horas_uteis == null).length, pendencias: pendentes.length,
      pendencias_historicas: pendenciasHistoricas.length },
    dias, ciclos: ciclos.sort((a, b) => ms(b.entrou_gerar_minuta_em || b.entrou_digitalizacao_em || b.saiu_cadastro_em) - ms(a.entrou_gerar_minuta_em || a.entrou_digitalizacao_em || a.saiu_cadastro_em)),
    cobertura: { primeiro_evento: datas.length ? iso(datas[0]) : null, ultimo_evento: datas.length ? iso(datas[datas.length - 1]) : null,
      ultimo_recebido: recebidos.length ? iso(recebidos.reduce((a, b) => Math.max(a, b))) : null, eventos: observados.length, confirmada: false }, avisos
  };
}

async function consultar({ semana, agora = new Date(), query = (sql, p) => db.pool.query(sql, p), exigirCadastro = false } = {}) {
  const per = periodo(semana, agora);
  // Buscar todo o histórico dos cartões candidatos, inclusive a entrada anterior à semana.
  const r = await query(`WITH candidatos AS (
    SELECT DISTINCT card_id FROM eventos_trello WHERE ocorrido_em < $1 AND
      (dados->'list'->>'id' = ANY($2::text[]) OR dados->'listBefore'->>'id' = ANY($2::text[]) OR dados->'listAfter'->>'id' = ANY($2::text[]))
  ) SELECT e.action_id, e.tipo, e.card_id, e.ocorrido_em, e.recebido_em, e.dados,
      (SELECT p.numero FROM protocolos p WHERE p.card_id = e.card_id ORDER BY p.numero LIMIT 1) AS protocolo
    FROM eventos_trello e JOIN candidatos c ON c.card_id = e.card_id
    WHERE e.ocorrido_em < $1 ORDER BY e.card_id, e.ocorrido_em, e.action_id LIMIT 150001`, [per.corte, Object.values(LISTAS)]);
  if (r.rows.length > 150000) throw Object.assign(new Error('Histórico acima do limite de leitura; o relatório requer processamento dedicado, sem truncar os dados.'), { status: 503 });
  return calcular(r.rows, { semana, agora, exigirCadastro });
}

const router = express.Router();
router.get('/semanal', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { res.json(await consultar({ semana: req.query.semana })); }
  catch (e) {
    if (!e.status) console.error('[protocolo-cadastro] falha ao consultar histórico');
    res.status(e.status || 500).json({ erro: e.status ? e.message : 'Não foi possível consultar o histórico do setor. Tente novamente.' });
  }
});
module.exports = { router, periodo, reconstruir, calcular, consultar, LISTAS, BOARDS };
