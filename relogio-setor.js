'use strict';

// Projeção operacional isolada. Nunca altera prazos do ato, eventos ou métricas.
const { createHash } = require('node:crypto');
const db = require('./db');
const P = require('./protocolo-cadastro');
const cal = require('./horas-uteis');
const CONFERENCIA = '694bea0e19bd024737e584d4';
const LISTAS_ATIVAS = Object.freeze([P.LISTAS.digitalizacao, P.LISTAS.cadastro, CONFERENCIA]);
const QUADROS = Object.freeze(Object.values(P.BOARDS));
const LISTAS_ARQUIVO = Object.freeze(['69344a6fc5e00099568028f9', '6a143e210fea5dbc7500a27b', '6a160df727d36bdda26df5bb']);
const CAMPOS = Object.freeze([{ name: 'Prazo do setor', type: 'date' }, { name: 'Relógio do setor', type: 'text' }]);
const INTERVALO_MS = 5 * 60 * 1000;
const LOCK = 1129197135;
const SCHEMA = `CREATE TABLE IF NOT EXISTS relogio_setor (
  card_id TEXT PRIMARY KEY, board_id TEXT, list_id TEXT, ciclo_id TEXT,
  estado TEXT NOT NULL DEFAULT 'pendente', ativo BOOLEAN NOT NULL DEFAULT false,
  precisa_repetir BOOLEAN NOT NULL DEFAULT false, prazo TIMESTAMPTZ,
  texto TEXT, evidencia_hash TEXT, cover_original JSONB,
  ultima_tentativa TIMESTAMPTZ NOT NULL DEFAULT now(), confirmado_em TIMESTAMPTZ,
  erro TEXT, detalhes JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS relogio_setor_pendentes ON relogio_setor(ativo, precisa_repetir);`;

function falha(codigo, status) {
  return Object.assign(new Error(codigo), { codigo, status,
    interromper: status === 429 || status === 401 || status === 403 || codigo === 'trello_timeout' });
}
function codigoErro(e) { return /^[a-z_0-9-]+$/.test(e && e.codigo || '') ? e.codigo : 'falha_na_sincronizacao'; }
function criarApi({ fetchFn = global.fetch, timeoutMs = 12000, env = process.env } = {}) {
  return async function api(method, path, body) {
    const key = String(env.TRELLO_KEY || '').trim(), token = String(env.TRELLO_TOKEN || '').trim();
    if (!key || !token) throw falha('trello_credencial_ausente', 401);
    const url = new URL('https://api.trello.com/1' + path);
    url.searchParams.set('key', key); url.searchParams.set('token', token);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetchFn(url.toString(), { method, signal: controller.signal,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      if (!r.ok) throw falha('trello_http_' + r.status, r.status);
      return await r.json();
    } catch (e) {
      if (e && e.codigo) throw e;
      throw falha(controller.signal.aborted ? 'trello_timeout' : 'trello_rede_ou_resposta');
    } finally { clearTimeout(timer); }
  };
}
function assinatura(eventos) {
  return createHash('sha256').update(JSON.stringify(eventos.map(e =>
    [e.action_id, e.tipo, e.ocorrido_em, e.dados]))).digest('hex');
}
function posicao(card) { return JSON.stringify([card.idBoard, card.idList, !!card.closed]); }
function noSetor(card) { return card.idBoard === P.BOARDS.protocolo && LISTAS_ATIVAS.includes(card.idList) && !card.closed; }
function horaBR(instante) {
  const l = cal.local(instante);
  return `${l.data.slice(8, 10)}/${l.data.slice(5, 7)} ${String(Math.floor(l.minutos / 60)).padStart(2, '0')}:${String(l.minutos % 60).padStart(2, '0')}`;
}
function hm(minutos) { return `${String(Math.floor(minutos / 60)).padStart(2, '0')}h${String(minutos % 60).padStart(2, '0')}`; }
function projetar(eventos, card, agora, calendario = cal.calendario) {
  const corte = new Date(new Date(agora).getTime() + 1).toISOString();
  const ciclos = P.reconstruir(eventos, { corte, horasUteis: calendario.horasUteis }).ciclos;
  const ciclo = ciclos[ciclos.length - 1];
  const base = { ciclo_id: ciclo?.id || null, prazo: null, ativo: noSetor(card), estado: 'pendente',
    texto: `⚠ Entrada não localizada · ${horaBR(agora)}`, detalhes: { ciclo: ciclo || null } };
  if (card.closed && ciclo?.status !== 'concluido') return { ...base, ativo: false, estado: 'interrompido', texto: `⏹ Arquivado · ${horaBR(agora)}` };
  if (!ciclo) return base;
  // Uma volta viva ao setor sem o evento correspondente não pode reutilizar o ciclo concluído.
  if (noSetor(card) && ciclo.status !== 'em_andamento') {
    return { ...base, texto: `⚠ Aguardando histórico · ${horaBR(agora)}` };
  }
  const concluido = ciclo.status === 'concluido' && !!ciclo.entrou_gerar_minuta_em;
  if (!noSetor(card) && !concluido) {
    return { ...base, ativo: false, texto: `⚠ Fora do fluxo · ${horaBR(agora)}` };
  }
  const fim = concluido ? ciclo.entrou_gerar_minuta_em : agora;
  if (!ciclo.entrou_digitalizacao_em) {
    return { ...base, ativo: !concluido && noSetor(card), estado: concluido ? 'concluido_sem_inicio' : 'pendente',
      texto: `${concluido ? '✓ Entregue; início ausente' : '⚠ Entrada não localizada'} · ${horaBR(fim)}` };
  }
  const horas = calendario.horasUteis(ciclo.entrou_digitalizacao_em, fim);
  const prazo = calendario.somarHorasUteis(ciclo.entrou_digitalizacao_em, 8).toISOString();
  const ressalva = concluido && !ciclo.cadastro_confirmado ? ' · s/ Cadastro' : '';
  const texto = concluido ? `${horas <= 8 ? '✅' : '🔴'} Concluído ${hm(Math.round(horas * 60))}${ressalva}` :
    horas > 8 ? `🔴 Excedido ${hm(Math.ceil((horas - 8) * 60))}` :
    `${horas >= 6 ? '🟠' : '⏳'} Restam ${hm(Math.max(0, Math.ceil((8 - horas) * 60)))}`;
  return { ...base, prazo, ativo: !concluido, estado: concluido ? 'concluido' : 'em_andamento',
    texto: `${texto} · ${horaBR(fim)}`, detalhes: { ciclo, horas_uteis: horas, meta_horas_uteis: 8 } };
}

function criarServico({ pool = db.pool, api = criarApi(), agora = () => new Date(), calendario = cal.calendario,
  habilitado = () => process.env.RELOGIO_SETOR_ATIVO === 'true', refreshHistory = null, beforeSweep = null,
  log = (msg) => console.log(msg), intervaloMs = INTERVALO_MS } = {}) {
  let timer = null, breve = null, rodando = false, ultimoResultado = null;
  const fila = new Set();
  async function init() { await pool.query(SCHEMA); }
  async function lerEventos(client, cardId) {
    const r = await client.query(`SELECT action_id,tipo,card_id,ocorrido_em,dados FROM eventos_trello
      WHERE card_id=$1 ORDER BY ocorrido_em,action_id LIMIT 20001`, [cardId]);
    if (r.rows.length > 20000) throw falha('historico_acima_limite');
    return r.rows;
  }
  async function lerCard(id) {
    return api('GET', `/cards/${id}?fields=id,idBoard,idList,closed,cover&customFieldItems=true`);
  }
  function achar(defs, campo) {
    const matches = defs.filter(d => d.name === campo.name);
    if (matches.length > 1) throw falha('campo_duplicado');
    if (matches[0] && matches[0].type !== campo.type) throw falha('campo_tipo_incompativel');
    return matches[0];
  }
  async function provisionar(boardId) {
    if (!QUADROS.includes(boardId)) throw falha('quadro_fora_escopo');
    let defs = await api('GET', `/boards/${boardId}/customFields`);
    for (const campo of CAMPOS) achar(defs, campo);
    if (defs.length + CAMPOS.filter(c => !achar(defs, c)).length > 50) throw falha('limite_campos_quadro');
    const result = {};
    for (const campo of CAMPOS) {
      let def = achar(defs, campo);
      if (!def) {
        let erro;
        try { await api('POST', '/customFields', { idModel: boardId, modelType: 'board', ...campo,
          pos: 'bottom', display_cardFront: true }); } catch (e) { erro = e; }
        // POST sem resultado é sempre reconciliado antes de decidir por nova tentativa.
        defs = await api('GET', `/boards/${boardId}/customFields`);
        def = achar(defs, campo);
        if (!def) throw erro || falha('criacao_campo_nao_confirmada');
      }
      if (def.display?.cardFront !== true) {
        let erro;
        try { await api('PUT', `/customFields/${def.id}`, { 'display/cardFront': true }); } catch (e) { erro = e; }
        defs = await api('GET', `/boards/${boardId}/customFields`);
        def = achar(defs, campo);
        if (!def || def.display?.cardFront !== true) throw erro || falha('visibilidade_nao_confirmada');
      }
      result[campo.type] = def.id;
    }
    return result;
  }
  function valor(card, id, tipo) {
    const v = (card.customFieldItems || []).find(f => f.idCustomField === id)?.value?.[tipo];
    return v == null || v === '' ? null : tipo === 'date' ? new Date(v).toISOString() : String(v);
  }
  async function campoConfirmado(cardId, id, tipo, desejado, card) {
    if (valor(card, id, tipo) === desejado) return card;
    let erro;
    try { await api('PUT', `/cards/${cardId}/customField/${id}/item`, { value: desejado === null ? '' : { [tipo]: desejado } }); }
    catch (e) { erro = e; }
    const depois = await lerCard(cardId);
    if (valor(depois, id, tipo) !== desejado) throw erro || falha('valor_campo_nao_confirmado');
    return depois;
  }
  async function guardar(client, card, p, hash, confirmado) {
    await client.query(`INSERT INTO relogio_setor
      (card_id,board_id,list_id,ciclo_id,estado,ativo,precisa_repetir,prazo,texto,evidencia_hash,ultima_tentativa,confirmado_em,erro,detalhes)
      VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8,$9,$10,$11,NULL,$12::jsonb)
      ON CONFLICT(card_id) DO UPDATE SET board_id=excluded.board_id,list_id=excluded.list_id,
      ciclo_id=excluded.ciclo_id,estado=excluded.estado,ativo=excluded.ativo,precisa_repetir=false,
      prazo=excluded.prazo,texto=excluded.texto,evidencia_hash=excluded.evidencia_hash,
      ultima_tentativa=excluded.ultima_tentativa,confirmado_em=excluded.confirmado_em,erro=NULL,detalhes=excluded.detalhes`,
    [card.id, card.idBoard, card.idList, p.ciclo_id, p.estado, p.ativo, p.prazo, p.texto, hash,
      agora(), confirmado ? agora() : null, JSON.stringify(p.detalhes)]);
  }
  async function erroCartao(client, cardId, e) {
    if (e.status === 404) {
      await client.query(`INSERT INTO relogio_setor(card_id,estado,ativo,precisa_repetir,erro)
        VALUES($1,'inacessivel',false,false,$2) ON CONFLICT(card_id) DO UPDATE SET
        estado='inacessivel',ativo=false,precisa_repetir=false,ultima_tentativa=now(),erro=excluded.erro`, [cardId, codigoErro(e)]);
      return;
    }
    await client.query(`INSERT INTO relogio_setor(card_id,precisa_repetir,erro) VALUES($1,true,$2)
      ON CONFLICT(card_id) DO UPDATE SET precisa_repetir=true,ultima_tentativa=now(),erro=excluded.erro`, [cardId, codigoErro(e)]);
  }
  async function sincronizar(client, cardId, campos) {
    if (refreshHistory) await refreshHistory(cardId);
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      const eventos = await lerEventos(client, cardId), hash = assinatura(eventos), card = await lerCard(cardId);
      const p = projetar(eventos, card, agora(), calendario);
      if (!QUADROS.includes(card.idBoard) || card.closed || LISTAS_ARQUIVO.includes(card.idList)) {
        await guardar(client, card, { ...p, ativo: false, estado: 'fora_escopo' }, hash, false);
        return 'fora_escopo';
      }
      // Sem passagem pelo setor, não decorar cartões de outros fluxos nem protocolos ainda na entrada.
      if (!p.ciclo_id && !noSetor(card)) return 'sem_ciclo';
      if (!noSetor(card) && !p.estado.startsWith('concluido')) {
        const anterior = await client.query('SELECT ativo FROM relogio_setor WHERE card_id=$1', [cardId]);
        if (!anterior.rows[0]?.ativo) return 'sem_ciclo';
      }
      const live = await lerCard(cardId), atuais = await lerEventos(client, cardId);
      if (posicao(live) !== posicao(card) || assinatura(atuais) !== hash) continue;
      let atual = live;
      // Capa integral encobre os campos; registrar o original ANTES da alteração mínima.
      const conclusaoRecente = p.estado.startsWith('concluido') &&
        new Date(p.detalhes.ciclo?.entrou_gerar_minuta_em).getTime() >= agora().getTime() - 7 * 86400000;
      if ((noSetor(atual) || conclusaoRecente) && atual.cover?.size === 'full') {
        await client.query(`INSERT INTO relogio_setor(card_id,cover_original) VALUES($1,$2::jsonb)
          ON CONFLICT(card_id) DO UPDATE SET cover_original=COALESCE(relogio_setor.cover_original,excluded.cover_original)`,
        [cardId, JSON.stringify(atual.cover)]);
        let erro;
        try { await api('PUT', `/cards/${cardId}`, { cover: { size: 'normal' } }); } catch (e) { erro = e; }
        atual = await lerCard(cardId);
        if (atual.cover?.size !== 'normal' || (live.cover.color || null) !== (atual.cover?.color || null) ||
            (live.cover.idAttachment || null) !== (atual.cover?.idAttachment || null)) throw erro || falha('capa_nao_confirmada');
        if (posicao(atual) !== posicao(card)) continue;
      }
      const defs = campos[card.idBoard];
      atual = await campoConfirmado(cardId, defs.date, 'date', p.prazo, atual);
      if (posicao(atual) !== posicao(card)) continue;
      atual = await campoConfirmado(cardId, defs.text, 'text', p.texto, atual);
      atual = await lerCard(cardId);
      const finais = await lerEventos(client, cardId);
      if (posicao(atual) !== posicao(card) || assinatura(finais) !== hash) continue;
      await guardar(client, atual, p, hash, true);
      return p.estado;
    }
    throw falha('cartao_em_movimentacao');
  }
  async function candidatos(client, cardId, cardIds, varrer) {
    if (cardId) return [cardId];
    if (cardIds && !varrer) return [...new Set(cardIds)];
    const ids = new Set(cardIds || []);
    for (const lista of LISTAS_ATIVAS) {
      const cards = await api('GET', `/lists/${lista}/cards?fields=id&filter=open`);
      for (const c of cards) ids.add(c.id);
    }
    const r = await client.query(`SELECT card_id FROM relogio_setor WHERE ativo OR precisa_repetir
      UNION SELECT DISTINCT e.card_id FROM eventos_trello e JOIN relogio_setor r ON r.card_id=e.card_id
        WHERE r.confirmado_em IS NOT NULL AND e.recebido_em > r.confirmado_em
          AND r.estado IN ('concluido','concluido_sem_inicio')
      UNION SELECT DISTINCT e.card_id FROM eventos_trello e WHERE e.ocorrido_em >= $1 AND
      e.dados->'board'->>'id'=$2 AND (e.dados->'list'->>'id'=$3 OR e.dados->'listAfter'->>'id'=$3)
      AND NOT EXISTS (SELECT 1 FROM relogio_setor r WHERE r.card_id=e.card_id AND
        ((r.estado IN ('concluido','concluido_sem_inicio') AND r.confirmado_em IS NOT NULL AND
          NOT r.precisa_repetir AND e.recebido_em <= r.confirmado_em) OR
         (r.estado IN ('inacessivel','fora_escopo') AND e.recebido_em <= r.ultima_tentativa)))`,
    [new Date(agora().getTime() - 7 * 86400000), P.BOARDS.tabeliao, P.LISTAS.gerar_minuta]);
    for (const c of r.rows) ids.add(c.card_id);
    return [...ids];
  }
  async function executar({ cardId, cardIds, varrer = false } = {}) {
    if (!habilitado()) return { ativo: false, motivo: 'desabilitado' };
    if (rodando) { for (const id of cardId ? [cardId] : cardIds || []) fila.add(id); return { ocupado: true }; }
    rodando = true;
    let client, travado = false;
    const resultado = { iniciado_em: agora().toISOString(), confirmados: 0, ignorados: 0, erros: 0, estados: {} };
    try {
      client = await pool.connect();
      travado = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK])).rows[0]?.ok === true;
      if (!travado) return { ocupado: true };
      if (beforeSweep && (varrer || (!cardId && !cardIds))) await beforeSweep();
      const campos = {};
      for (const board of QUADROS) campos[board] = await provisionar(board);
      const ids = await candidatos(client, cardId, cardIds, varrer);
      for (const id of ids) {
        if (!/^[a-f0-9]{24}$/.test(id)) continue;
        try {
          const estado = await sincronizar(client, id, campos);
          resultado.estados[estado] = (resultado.estados[estado] || 0) + 1;
          if (['sem_ciclo', 'fora_escopo'].includes(estado)) resultado.ignorados++; else resultado.confirmados++;
        } catch (e) {
          resultado.erros++; resultado.ultimo_erro = codigoErro(e);
          await erroCartao(client, id, e);
          if (e.interromper) { resultado.interrompido = true; break; }
        }
      }
      return resultado;
    } catch (e) {
      resultado.erros++; resultado.ultimo_erro = codigoErro(e);
      return resultado;
    } finally {
      if (travado) await client.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {});
      if (client) client.release();
      resultado.terminado_em = agora().toISOString(); ultimoResultado = resultado; rodando = false;
    }
  }
  function disparar(op) {
    executar(op).then(r => { if (r.erros) log(`[relogio-setor] ${r.erros} pendência(s): ${r.ultimo_erro}`); })
      .catch(() => log('[relogio-setor] falha_na_sincronizacao'));
  }
  function enfileirar(cardId) {
    if (!habilitado() || !/^[a-f0-9]{24}$/.test(cardId || '')) return;
    fila.add(cardId);
    if (!breve) {
      breve = setTimeout(() => { breve = null; const ids = [...fila]; fila.clear(); disparar({ cardIds: ids }); }, 1500);
      breve.unref?.();
    }
  }
  async function iniciar() {
    if (!habilitado() || timer) return false;
    await init();
    timer = setInterval(() => { const ids = [...fila]; fila.clear(); disparar({ cardIds: ids, varrer: true }); }, intervaloMs);
    timer.unref?.(); disparar({}); return true;
  }
  function parar() { clearInterval(timer); clearTimeout(breve); timer = breve = null; fila.clear(); }
  async function status() {
    let r;
    try { r = await pool.query(`SELECT estado,count(*)::int AS quantidade,max(confirmado_em) AS ultimo_confirmado,
      count(*) FILTER(WHERE precisa_repetir)::int AS pendentes FROM relogio_setor GROUP BY estado`); }
    catch (e) { if (e.code === '42P01') r = { rows: [] }; else throw falha('status_indisponivel'); }
    return { ativo: habilitado(), iniciado: !!timer, rodando, intervalo_minutos: intervaloMs / 60000,
      ultimo_resultado: ultimoResultado, estados: r.rows };
  }
  return { init, iniciar, parar, executar, enfileirar, status, provisionar,
    sincronizarCartao: cardId => executar({ cardId }) };
}
const padrao = criarServico();
module.exports = { ...padrao, criarServico, criarApi, projetar, assinatura, CAMPOS, QUADROS, LISTAS_ATIVAS, SCHEMA, INTERVALO_MS };
