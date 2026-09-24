// rastreio.js — rastreio dos cartões no Trello para os relatórios das escreventes (v1.38).
//
// O webhook do Trello que o hub já recebe (POST /webhook/trello, registrado pelo
// setup.js nos quadros 00, 01 e 02-*) entrega cada ação desses quadros. As ações que
// mudam a posição de um cartão entram em eventos_trello, com o id da ação como chave:
// o mesmo evento entregue duas vezes (retentativa do Trello, carga retroativa por cima
// do webhook) é gravado uma vez só.
//
// Daí o cartão é RECONSTRUÍDO por inteiro a partir de todos os seus eventos:
// passagens (cada estada numa lista, em horas úteis), pendências e a conclusão. A
// reconstrução apaga e regrava as linhas do cartão numa transação, então:
//   - ordem de chegada não importa (o evento atrasado entra no lugar certo);
//   - reprocessar é seguro (o resultado é sempre o mesmo);
//   - cartão que vai e volta, ou troca de quadro, não duplica nada.
//
// Variáveis: TRELLO_SECRET (segredo da MESMA chave TRELLO_KEY do hub, em
// trello.com/power-ups/admin → a chave → "Segredo"), BASE_URL (a mesma do setup.js)
// ou TRELLO_WEBHOOK_URL (a URL exata registrada, se for outra).
'use strict';

const crypto = require('crypto');
const db = require('./db');
const cal = require('./horas-uteis');
const { extrairDoTitulo, normalizarTipoAto } = require('./tipos-ato');

// ------------------------------------------------------------ assinatura do webhook
// O Trello assina cada entrega com HMAC-SHA1(segredo, corpo + callbackURL) em base64,
// no cabeçalho X-Trello-Webhook. O exemplo oficial (Node antigo) faz o update() sem
// codificação — 'binary' —, o que diverge do UTF-8 quando o corpo tem acento (nome de
// parte, "Romênia"). Aceitamos as duas formas; ambas exigem o segredo.
function urlDoWebhook() {
  if (process.env.TRELLO_WEBHOOK_URL) return process.env.TRELLO_WEBHOOK_URL.trim();
  return `${String(process.env.BASE_URL || '').trim().replace(/\/+$/, '')}/webhook/trello`;
}
// A assinatura depende da URL EXATA do registro. O setup.js registra
// `${BASE_URL}/webhook/trello` sem tirar a barra final: com BASE_URL terminada em "/",
// a URL registrada tem "//" — as duas formas valem.
function urlsDoWebhook() {
  if (process.env.TRELLO_WEBHOOK_URL) return [urlDoWebhook()];
  return [...new Set([urlDoWebhook(), `${String(process.env.BASE_URL || '').trim()}/webhook/trello`])];
}

function assinaturaValida(corpo, cabecalho, segredo, callbackURL) {
  if (!cabecalho || !segredo) return false;
  const esperado = Buffer.from(String(cabecalho));
  const hmac = buf => crypto.createHmac('sha1', segredo).update(buf).digest('base64');
  const candidatos = [
    hmac(Buffer.concat([corpo, Buffer.from(callbackURL, 'utf8')])),
    hmac(Buffer.from(corpo.toString('utf8') + callbackURL, 'latin1'))
  ];
  return candidatos.some(c => {
    const b = Buffer.from(c);
    return b.length === esperado.length && crypto.timingSafeEqual(b, esperado);
  });
}

// 'ok' | 'invalida' | 'sem-segredo'. Sem TRELLO_SECRET NADA entra no rastreio
// (fail-closed para as métricas).
let avisouSemSegredo = false;
const invalidas = { total: 0, ultima: null };   // para o /hub/relatorios/status
function verificarWebhook(corpo, cabecalho) {
  const segredo = String(process.env.TRELLO_SECRET || '').trim();
  if (!segredo) {
    if (!avisouSemSegredo) {
      console.error('[rastreio] TRELLO_SECRET ausente: o webhook não será gravado para os relatórios');
      avisouSemSegredo = true;
    }
    return 'sem-segredo';
  }
  if (urlsDoWebhook().some(url => assinaturaValida(corpo, cabecalho, segredo, url))) return 'ok';
  invalidas.total++;
  invalidas.ultima = new Date().toISOString();
  // segredo ou URL errados barram TODAS as entregas: avisa no log, no máximo a cada 10 min
  if (Date.now() - ultimoAvisoInvalida > 10 * 60e3) {
    console.error(`[rastreio] webhook com assinatura inválida: fica fora dos relatórios. Confira TRELLO_SECRET e se a URL registrada no Trello é exatamente ${urlDoWebhook()} (senão, TRELLO_WEBHOOK_URL)`);
    ultimoAvisoInvalida = Date.now();
  }
  return 'invalida';
}
let ultimoAvisoInvalida = 0;
const assinaturasInvalidas = () => ({ ...invalidas });

// ------------------------------------------------------------ quais ações interessam
const TIPOS_CRIACAO = new Set(['createCard', 'copyCard', 'convertToCardFromCheckItem', 'emailCard']);
const TIPOS_RASTREADOS = new Set([...TIPOS_CRIACAO, 'moveCardToBoard', 'moveCardFromBoard', 'deleteCard', 'updateCard']);
// o mesmo conjunto, no formato do parâmetro filter da API (carga retroativa)
const FILTRO_API = [...TIPOS_CRIACAO, 'moveCardToBoard', 'moveCardFromBoard', 'deleteCard',
  'updateCard:idList', 'updateCard:closed', 'updateCard:name'].join(',');

function relevante(a) {
  if (!a || !a.id || !TIPOS_RASTREADOS.has(a.type)) return false;
  const d = a.data || {};
  if (!d.card || !d.card.id) return false;
  if (a.type === 'updateCard') return !!(d.listAfter || (d.old && ('closed' in d.old || 'name' in d.old)));
  return true;
}

// ------------------------------------------------------------ categorias das listas
// O nome da lista diz em que fase o ato está. Custo pessoal = elaboração + retrabalho
// no quadro da própria escrevente; conferência, pendência documental e assinatura
// dependem de terceiros e ficam de fora.
function semAcento(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
}
function categoriaDaLista(nome) {
  const s = semAcento(nome);
  if (!s) return 'fora';                                         // quadro não monitorado
  if (/FINALIZAD/.test(s)) return 'finalizado';
  if (/ARQUIV|SEM EFEITO/.test(s)) return 'arquivo';
  if (/PENDENC|^AGUARDA$/.test(s)) return 'pendencia';           // PENDÊNCIAS, AGUARDA (01)
  if (/AJUSTE|RETORNO/.test(s)) return 'retrabalho';             // Ajuste/Retorno
  if (/ASSINATURA/.test(s)) return 'assinatura';                 // Agendar / Aguardando Assinatura
  if (/CONFER|AUDITORIA|MESA/.test(s)) return 'conferencia';     // Conferência de Minuta, MESA TABELIÃO…
  if (/REVISAR|MINUTA|ELABORA/.test(s)) return 'elaboracao';     // Revisar Minuta
  if (/PROTOCOLO|ENTRADA|TRIAGEM|DIGITALIZ|CADASTRO/.test(s)) return 'entrada';
  return 'outros';
}
const TRABALHO = new Set(['elaboracao', 'retrabalho', 'conferencia', 'pendencia', 'assinatura']);
const ATIVAS = new Set(['elaboracao', 'retrabalho']);

// ------------------------------------------------------------ reconstrução (pura)
const ms = v => new Date(v).getTime();
const r2 = n => (n == null ? null : Math.round(n * 100) / 100);

// eventos: [{ action_id, tipo, ocorrido_em, dados }] de UM cartão (qualquer ordem).
// ctx: { escreventes: [{ login, board_id, list_finalizado_id }], horasUteis, protocolo? }
// → { passagens, pendencias, conclusao|null, titulo, card_short }
function reconstruir(eventos, ctx) {
  const horasUteis = ctx.horasUteis || cal.horasUteis;
  const porBoard = new Map((ctx.escreventes || []).map(e => [e.board_id, e]));
  const finais = new Map((ctx.escreventes || []).map(e => [e.list_finalizado_id, e]));
  const evs = [...eventos].sort((a, b) => (ms(a.ocorrido_em) - ms(b.ocorrido_em)) ||
    (a.action_id < b.action_id ? -1 : a.action_id > b.action_id ? 1 : 0));
  const chegadasBoard = evs.filter(e => e.tipo === 'moveCardToBoard').map(e => ms(e.ocorrido_em));

  const brutas = [];
  let atual = null, titulo = null, cardShort = null;
  const abrir = (ev, board, list, entrou) => {
    atual = {
      board_id: (board && board.id) || null, list_id: (list && list.id) || null,
      list_nome: (list && list.name) || null, entrou_em: entrou, saiu_em: null,
      action_entrada: ev.action_id, action_saida: null
    };
    brutas.push(atual);
  };
  const fechar = ev => {
    if (!atual) return;
    atual.saiu_em = new Date(ev.ocorrido_em);
    atual.action_saida = ev.action_id;
    atual = null;
  };
  // estada cuja ENTRADA não vimos (cartão anterior à carga): início desconhecido
  const semInicio = (ev, board, list) => {
    brutas.push({
      board_id: (board && board.id) || null, list_id: (list && list.id) || null,
      list_nome: (list && list.name) || null, entrou_em: null, saiu_em: new Date(ev.ocorrido_em),
      action_entrada: '?' + ev.action_id, action_saida: ev.action_id
    });
  };

  for (const ev of evs) {
    const d = ev.dados || {};
    const quando = new Date(ev.ocorrido_em);
    if (d.card && d.card.name) titulo = d.card.name;
    if (d.card && d.card.shortLink) cardShort = d.card.shortLink;
    if (TIPOS_CRIACAO.has(ev.tipo) || ev.tipo === 'moveCardToBoard') {
      fechar(ev); abrir(ev, d.board, d.list, quando);
    } else if (ev.tipo === 'moveCardFromBoard') {
      // o par moveCardToBoard (quadro de destino monitorado) já registra a mudança
      if (chegadasBoard.some(t => Math.abs(t - quando.getTime()) <= 10000)) continue;
      if (!atual && d.list) semInicio(ev, d.board, d.list);
      fechar(ev); abrir(ev, d.boardTarget, null, quando);
    } else if (ev.tipo === 'updateCard') {
      if (d.listAfter) {
        if (atual) fechar(ev); else semInicio(ev, d.board, d.listBefore);
        abrir(ev, d.board, d.listAfter, quando);
      } else if (d.old && 'closed' in d.old) {
        if (d.card && d.card.closed) {                           // arquivado
          if (!atual && d.list) semInicio(ev, d.board, d.list);
          fechar(ev);
        } else if (!atual) {                                     // desarquivado
          abrir(ev, d.board, d.list, quando);
        }
      }
    } else if (ev.tipo === 'deleteCard') {
      fechar(ev);
    }
  }

  // enriquecimento: categoria, dono do quadro, horas úteis
  const passagens = brutas.map(p => {
    const dono = porBoard.get(p.board_id);
    return {
      ...p,
      categoria: categoriaDaLista(p.list_nome),
      escrevente: dono ? dono.login : null,
      horas_uteis: (p.entrou_em && p.saiu_em) ? r2(horasUteis(p.entrou_em, p.saiu_em)) : null
    };
  });

  // responsável em cada momento: dono do quadro; fora dos quadros das escreventes
  // (00, 01), a última escrevente que teve o cartão — ou a próxima, se ainda não teve.
  const responsavel = passagens.map(p => p.escrevente);
  for (let i = 1; i < responsavel.length; i++) if (!responsavel[i]) responsavel[i] = responsavel[i - 1];
  for (let i = responsavel.length - 2; i >= 0; i--) if (!responsavel[i]) responsavel[i] = responsavel[i + 1];

  const pendencias = passagens
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.categoria === 'pendencia' || p.categoria === 'retrabalho')
    .map(({ p, i }) => ({
      tipo: p.categoria === 'pendencia' ? 'documental' : 'ajuste',
      escrevente: responsavel[i], board_id: p.board_id, list_nome: p.list_nome,
      aberta_em: p.entrou_em, fechada_em: p.saiu_em, horas_uteis: p.horas_uteis,
      action_abertura: p.action_entrada
    }));

  // conclusão: chegada a uma lista Finalizado de escrevente
  const ehFinal = p => p.entrou_em && (finais.has(p.list_id) || (p.escrevente && p.categoria === 'finalizado'));
  const idxChegadas = passagens.map((p, i) => (ehFinal(p) ? i : -1)).filter(i => i >= 0);
  let conclusao = null;
  if (idxChegadas.length) {
    const iUlt = idxChegadas[idxChegadas.length - 1];
    const ultima = passagens[iUlt];
    const dona = (finais.get(ultima.list_id) || porBoard.get(ultima.board_id)).login;
    let reaberturas = 0;
    for (let k = 0; k < idxChegadas.length - 1; k++) {
      if (passagens.slice(idxChegadas[k] + 1, idxChegadas[k + 1]).some(p => TRABALHO.has(p.categoria))) reaberturas++;
    }
    const iEntrada = passagens.findIndex((p, i) => i < iUlt && p.escrevente === dona);
    const janela = iEntrada >= 0 ? passagens.slice(iEntrada, iUlt) : [];
    const entrada = iEntrada >= 0 ? passagens[iEntrada] : null;
    const soma = f => r2(janela.filter(f).reduce((s, p) => s + (p.horas_uteis || 0), 0));
    const completo = !!(entrada && entrada.entrou_em);
    const tit = extrairDoTitulo(titulo);
    const prot = ctx.protocolo || null;
    conclusao = {
      escrevente: dona,
      protocolo: prot && prot.numero != null ? Number(prot.numero) : tit.protocolo,
      tipo_ato: prot && prot.ato ? normalizarTipoAto(prot.ato) : tit.tipo_ato,
      rotulo: tit.rotulo || null,
      card_short: cardShort,
      concluido_em: passagens[idxChegadas[0]].entrou_em,
      ultima_conclusao_em: ultima.entrou_em,
      reaberturas,
      entrada_mesa_em: entrada ? entrada.entrou_em : null,
      horas_mesa: completo ? r2(horasUteis(entrada.entrou_em, ultima.entrou_em)) : null,
      horas_ativas: completo ? soma(p => p.escrevente === dona && ATIVAS.has(p.categoria)) : null,
      horas_pendencia: completo ? soma(p => p.categoria === 'pendencia') : null,
      horas_conferencia: completo ? soma(p => p.categoria === 'conferencia') : null,
      horas_assinatura: completo ? soma(p => p.categoria === 'assinatura') : null,
      retornos: janela.filter(p => p.categoria === 'retrabalho').length,
      historico_completo: completo
    };
  }
  return { passagens, pendencias, conclusao, titulo, card_short: cardShort };
}

// ------------------------------------------------------------ banco
const q = (texto, params) => db.pool.query(texto, params);

// escreventes em cache (mudam raramente; 5 min basta)
let cacheEsc = null;
async function escreventes(cliente) {
  if (cacheEsc && Date.now() - cacheEsc.em < 5 * 60e3) return cacheEsc.lista;
  const r = await (cliente || db.pool).query(
    'SELECT login, nome, board_id, list_finalizado_id FROM escreventes WHERE ativo ORDER BY nome');
  cacheEsc = { em: Date.now(), lista: r.rows };
  return r.rows;
}
function esquecerEscreventes() { cacheEsc = null; }

function linhaEvento(a, origem) {
  const d = a.data || {};
  return [a.id, a.type, d.card.id, (d.board && d.board.id) || null, new Date(a.date), origem, JSON.stringify(d)];
}

// grava as ações relevantes (as outras são ignoradas) → quantas eram novas
async function registrarEventos(acoes, origem = 'webhook') {
  const linhas = (acoes || []).filter(relevante).map(a => linhaEvento(a, origem));
  let novos = 0;
  for (let i = 0; i < linhas.length; i += 200) {
    const lote = linhas.slice(i, i + 200);
    const vals = [], params = [];
    lote.forEach((l, k) => {
      vals.push(`(${l.map((_, j) => '$' + (k * 7 + j + 1)).join(',')})`);
      params.push(...l);
    });
    const r = await q(`INSERT INTO eventos_trello (action_id, tipo, card_id, board_id, ocorrido_em, origem, dados)
      VALUES ${vals.join(',')} ON CONFLICT (action_id) DO NOTHING RETURNING action_id`, params);
    novos += r.rowCount;
  }
  return novos;
}
const registrarEvento = (acao, origem) => registrarEventos([acao], origem);

async function inserirVarios(cliente, tabela, colunas, linhas) {
  for (let i = 0; i < linhas.length; i += 100) {
    const lote = linhas.slice(i, i + 100);
    const vals = [], params = [];
    lote.forEach((l, k) => {
      vals.push(`(${colunas.map((_, j) => '$' + (k * colunas.length + j + 1)).join(',')})`);
      params.push(...colunas.map(c => l[c] === undefined ? null : l[c]));
    });
    await cliente.query(`INSERT INTO ${tabela} (${colunas.join(',')}) VALUES ${vals.join(',')}`, params);
  }
}

// Registro do e-Protocolo (tabela protocolos do db.js): quando o cartão nasceu por lá,
// o tipo de ato de lá é o canônico. Sem registro, vale o título.
async function protocoloDoCartao(cliente, cardId) {
  const r = await cliente.query(`SELECT numero, dados->>'ato' AS ato FROM protocolos WHERE card_id = $1 LIMIT 1`, [cardId]);
  return r.rows[0] || null;
}

const COL_PASSAGEM = ['card_id', 'board_id', 'list_id', 'list_nome', 'categoria', 'escrevente',
  'entrou_em', 'saiu_em', 'horas_uteis', 'action_entrada', 'action_saida'];
const COL_PENDENCIA = ['card_id', 'tipo', 'escrevente', 'board_id', 'list_nome', 'aberta_em',
  'fechada_em', 'horas_uteis', 'action_abertura'];
const COL_CONCLUSAO = ['escrevente', 'protocolo', 'tipo_ato', 'rotulo', 'card_short', 'concluido_em',
  'ultima_conclusao_em', 'reaberturas', 'entrada_mesa_em', 'horas_mesa', 'horas_ativas',
  'horas_pendencia', 'horas_conferencia', 'horas_assinatura', 'retornos', 'historico_completo'];

// Reconstrói um cartão inteiro, numa transação, com trava por cartão (dois webhooks
// do mesmo cartão ao mesmo tempo esperam um pelo outro).
async function processarCartao(cardId) {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['rastreio:' + cardId]);
    const evs = (await c.query(
      'SELECT action_id, tipo, ocorrido_em, dados FROM eventos_trello WHERE card_id = $1', [cardId])).rows;
    const prot = await protocoloDoCartao(c, cardId);
    const r = reconstruir(evs, { escreventes: await escreventes(c), protocolo: prot });

    await c.query('DELETE FROM passagens WHERE card_id = $1', [cardId]);
    await c.query('DELETE FROM pendencias WHERE card_id = $1', [cardId]);
    await inserirVarios(c, 'passagens', COL_PASSAGEM, r.passagens.map(p => ({ ...p, card_id: cardId })));
    await inserirVarios(c, 'pendencias', COL_PENDENCIA, r.pendencias.map(p => ({ ...p, card_id: cardId })));
    if (r.conclusao) {
      const cols = ['card_id', ...COL_CONCLUSAO];
      const vals = [cardId, ...COL_CONCLUSAO.map(k => r.conclusao[k])];
      await c.query(`INSERT INTO conclusoes (${cols.join(',')}, atualizado_em)
        VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}, now())
        ON CONFLICT (card_id) DO UPDATE SET ${COL_CONCLUSAO.map(k => `${k} = EXCLUDED.${k}`).join(', ')},
        atualizado_em = now()`, vals);
    } else {
      await c.query('DELETE FROM conclusoes WHERE card_id = $1', [cardId]);
    }
    // só os eventos que entraram NESTA reconstrução (um que chegou depois da leitura
    // continua pendente e tem a própria reconstrução disparada pelo webhook)
    await c.query('UPDATE eventos_trello SET processado_em = now() WHERE action_id = ANY($1::text[]) AND processado_em IS NULL',
      [evs.map(e => e.action_id)]);
    await c.query('COMMIT');
    return { passagens: r.passagens.length, pendencias: r.pendencias.length, concluido: !!r.conclusao };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Todos os cartões com evento ainda não processado (sobra de queda do servidor) ou,
// com todos=true, todos os cartões (depois de mudar regra de categoria ou calendário).
async function reprocessar({ todos = false, log = () => {} } = {}) {
  const r = await q(`SELECT DISTINCT card_id FROM eventos_trello ${todos ? '' : 'WHERE processado_em IS NULL'}`);
  let n = 0;
  for (const { card_id } of r.rows) {
    await processarCartao(card_id);
    if (++n % 200 === 0) log(`  … ${n}/${r.rows.length} cartões reprocessados`);
  }
  return n;
}

module.exports = {
  assinaturaValida, verificarWebhook, urlDoWebhook, urlsDoWebhook, assinaturasInvalidas, relevante, FILTRO_API,
  categoriaDaLista, reconstruir,
  registrarEventos, registrarEvento, processarCartao, reprocessar, escreventes, esquecerEscreventes
};
