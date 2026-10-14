'use strict';
// Prazo global: identidade do cartão, nunca a lista ou o quadro, é a chave.
const db = require('./db');
const M = require('./prazos-atos-modelo');
const { criarApi } = require('./relogio-setor');
const SCHEMA = `CREATE TABLE IF NOT EXISTS prazos_atos (
  card_id TEXT PRIMARY KEY, protocolo INTEGER NOT NULL, inicio TIMESTAMPTZ NOT NULL,
  evidencia TEXT NOT NULL, vencimento TIMESTAMPTZ NOT NULL, regra JSONB NOT NULL,
  urgente_em TIMESTAMPTZ, board_id TEXT, list_id TEXT, estado TEXT NOT NULL DEFAULT 'ativo',
  cor TEXT, cover_original JSONB, confirmado_em TIMESTAMPTZ, erro TEXT, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE prazos_atos ADD COLUMN IF NOT EXISTS responsavel_login TEXT;
ALTER TABLE prazos_atos ADD COLUMN IF NOT EXISTS card_url TEXT;
CREATE INDEX IF NOT EXISTS prazos_atos_responsavel ON prazos_atos(responsavel_login,estado,vencimento);
CREATE TABLE IF NOT EXISTS prazos_atos_alertas (
  chave TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES prazos_atos(card_id),
  tipo TEXT NOT NULL, estado TEXT NOT NULL DEFAULT 'pendente', criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  enviado_em TIMESTAMPTZ, action_id TEXT
);`;
const CAMPOS = [{ name: 'Início do ato', type: 'date' }, { name: 'Prazo do ato', type: 'date' },
  { name: 'Relógio do Ato', type: 'text' }];
const LOCK = 1129197136;
const validarId = id => /^[a-f0-9]{24}$/.test(id || '');
const erroSeguro = e => /^[a-z_0-9]+$/.test(e?.codigo || e?.message || '') ? (e.codigo || e.message) : 'sincronizacao_nao_confirmada';
function criarServico({ pool = db.pool, api = criarApi(), agora = () => new Date(),
  habilitado = () => process.env.PRAZOS_ATOS_ATIVO !== 'false',
  quadros = async () => [...new Set([...(await require('./carga_retroativa').quadrosMonitorados()),
    process.env.BOARD_03 || '69ee737ed34c3daf7791f9e0',
    ...String(process.env.BOARDS_PRAZOS || '').split(',').map(s=>s.trim()).filter(Boolean),
    process.env.BOARD_04 || '6a8ca1ddc8f6574231ab8ab0'])],
  tabeliao = () => process.env.PRAZOS_TABELIAO_TRELLO || 'tnitabaiana',
  log = console.log, intervaloMs = 300000 } = {}) {
  let timer, breve, rodando = false, iniciado = false, ultimo = null;
  const fila = new Set();
  const init = () => pool.query(SCHEMA);
  async function historico(id, filtro) {
    const acoes = [], vistos = new Set(); let antes;
    for (let p = 0; p < 20; p++) {
      const q = new URLSearchParams({ filter: filtro, limit: '1000', memberCreator: 'false' });
      if (antes) q.set('before', antes);
      const lote = await api('GET', `/cards/${id}/actions?${q}`);
      if (!Array.isArray(lote)) throw Error('historico_invalido');
      for (const a of lote) {
        if (!validarId(a.id) || !Number.isFinite(Date.parse(a.date)) || a.data?.card?.id !== id)
          throw Error('historico_divergente');
        if (!vistos.has(a.id)) { vistos.add(a.id); acoes.push(a); }
      }
      if (lote.length < 1000) return acoes;
      const cursor = lote[lote.length - 1].id;
      if (antes === cursor) throw Error('historico_incompleto');
      antes = cursor;
    }
    throw Error('historico_incompleto');
  }
  const lerCard = id => api('GET', `/cards/${id}?fields=id,name,idBoard,idList,closed,due,dueComplete,idMembers,labels,cover,shortUrl&customFieldItems=true`);
  async function campos(board) {
    let defs = await api('GET', `/boards/${board}/customFields`);
    const resultado = {};
    for (const c of CAMPOS) {
      let matches = defs.filter(d => d.name === c.name);
      if (matches.length > 1 || (matches[0] && matches[0].type !== c.type)) throw Error('campo_incompativel');
      let def = matches[0];
      if (!def) {
        if (defs.length >= 50) throw Error('limite_campos');
        let erro;
        try { await api('POST', '/customFields', { idModel: board, modelType: 'board', ...c, pos: 'bottom', display_cardFront: true }); }
        catch (e) { erro = e; }
        defs = await api('GET', `/boards/${board}/customFields`);
        matches = defs.filter(d => d.name === c.name);
        if (matches.length !== 1 || matches[0].type !== c.type) throw erro || Error('campo_nao_confirmado');
        def = matches[0];
      }
      if (!def.display?.cardFront) {
        await api('PUT', `/customFields/${def.id}`, { 'display/cardFront': true });
        const confirmacao = await api('GET', `/customFields/${def.id}`);
        if (confirmacao.display?.cardFront !== true) throw Error('visibilidade_nao_confirmada');
      }
      resultado[c.name] = def;
    }
    return resultado;
  }
  async function projetar(card, estado, s, fase, defs) {
    const valores = { 'Início do ato': estado.inicio, 'Prazo do ato': estado.vencimento,
      'Relógio do Ato': (fase === 'concluido' ? '✅ Concluído' : s.texto) + ' · ' +
        require('./horas-uteis').dataBR(require('./horas-uteis').local(estado.vencimento).data) };
    for (const [nome, v] of Object.entries(valores)) {
      const d = defs[nome], item = (card.customFieldItems || []).find(x => x.idCustomField === d.id)?.value?.[d.type];
      const atual = d.type === 'date' && item ? new Date(item).toISOString() : item;
      if (atual === v) continue;
      let erro;
      try { await api('PUT', `/cards/${card.id}/customField/${d.id}/item`, { value: { [d.type]: v } }); }
      catch (e) { erro = e; }
      const depois = await lerCard(card.id);
      const confirmado = depois.customFieldItems?.find(x => x.idCustomField === d.id)?.value?.[d.type];
      if ((d.type === 'date' && confirmado ? new Date(confirmado).toISOString() : confirmado) !== v)
        throw erro || Error('projecao_nao_confirmada');
      if (depois.idBoard !== card.idBoard || depois.idList !== card.idList || depois.closed) throw Error('cartao_em_movimentacao');
    }
    // A agenda usa due na fase de assinatura. O prazo canônico continua nos campos acima.
    if (fase === 'ativo' && (card.due !== estado.vencimento || card.dueComplete)) {
      let erro;
      try { await api('PUT', `/cards/${card.id}`, { due: estado.vencimento, dueComplete: false, dueReminder: 1440 }); }
      catch (e) { erro = e; }
      const depois = await lerCard(card.id);
      if (depois.due !== estado.vencimento || depois.dueComplete) throw erro || Error('due_nao_confirmado');
    }
  }
  async function avisar(client, card, estado, s) {
    if (!s.aviso) return;
    // O vencimento faz parte da chave: uma urgência que antecipa o prazo abre novo conjunto de avisos.
    const chave = require('node:crypto').createHash('sha256').update(`${card.id}|${estado.vencimento}|${s.aviso}`).digest('hex').slice(0,24);
    await client.query(`INSERT INTO prazos_atos_alertas(chave,card_id,tipo) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [chave,card.id,s.aviso]);
    const anterior = (await client.query('SELECT estado FROM prazos_atos_alertas WHERE chave=$1', [chave])).rows[0];
    if (anterior?.estado === 'enviado') return;
    const marcador = `[prazo-cn2o:${chave}]`;
    // Verificação antes de POST: recupera o caso de comentário aceito cujo ACK se perdeu.
    const comentarios = await historico(card.id, 'commentCard');
    let acao = comentarios.find(a => a.data?.text?.includes(marcador));
    if (!acao) {
      const pessoas = new Set([tabeliao()]);
      for (const id of card.idMembers || []) {
        const m = await api('GET', `/members/${id}?fields=username`);
        if (/^[a-zA-Z0-9_]+$/.test(m.username || '')) pessoas.add(m.username);
      }
      const mencoes = [...pessoas].filter(p => /^[a-zA-Z0-9_]+$/.test(p)).map(p => '@' + p).join(' ');
      acao = await api('POST', `/cards/${card.id}/actions/comments`, {
        text: `${mencoes}\n${s.texto}. Prazo de conclusão: ${require('./horas-uteis').dataBR(require('./horas-uteis').local(estado.vencimento).data)}.\nContagem desde ${estado.regra.ato === 'CERT' ? 'o protocolo da certidão' : 'a entrada em Cadastro Extradigital'}; mudanças de lista/quadro e pendências não reiniciam o prazo.\n${marcador}` });
    }
    await client.query(`UPDATE prazos_atos_alertas SET estado='enviado',enviado_em=now(),action_id=$2 WHERE chave=$1`, [chave,acao.id]);
  }
  async function sincronizar(client, id, boards, cache) {
    const reg = (await client.query('SELECT numero,dados,criado_em FROM protocolos WHERE card_id=$1', [id])).rows[0];
    if (!reg) return 'sem_protocolo';
    let card = await lerCard(id);
    if (!boards.includes(card.idBoard)) return 'fora_escopo';
    if (!cache.listas[card.idBoard]) cache.listas[card.idBoard] = await api('GET', `/boards/${card.idBoard}/lists?fields=id,name&filter=all`);
    const lista = cache.listas[card.idBoard].find(l => l.id === card.idList);
    if (!lista) throw Error('lista_nao_localizada');
    const fase = M.fase(lista.name, card.closed);
    let estado = (await client.query('SELECT * FROM prazos_atos WHERE card_id=$1', [id])).rows[0];
    if (fase === 'arquivado') {
      if (estado) {
        await registrarConclusao(client,card,estado,reg,estado.responsavel_login);
        await client.query("UPDATE prazos_atos SET estado='arquivado',atualizado_em=now() WHERE card_id=$1",[id]);
      }
      return 'arquivado';
    }
    if (fase === 'concluido' && !estado) return 'concluido_sem_carga';
    let acoes = [];
    if (!estado) {
      acoes = await historico(id, 'createCard,copyCard,emailCard,convertToCardFromCheckItem,updateCard:idList,moveCardToBoard,addLabelToCard');
      const inicio = M.primeiroInicio(acoes,reg.dados,reg.criado_em);
      if (!inicio) return 'aguarda_cadastro';
      const r = M.regra(reg.dados, card.labels);
      estado = { inicio: inicio.em, evidencia: inicio.evidencia, regra: r, vencimento: M.vencimento(inicio.em,r),
        urgente_em: reg.dados.urgente ? inicio.em : null };
      await client.query(`INSERT INTO prazos_atos(card_id,protocolo,inicio,evidencia,vencimento,regra,urgente_em)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT DO NOTHING`,
      [id,reg.numero,estado.inicio,estado.evidencia,estado.vencimento,JSON.stringify(r),estado.urgente_em]);
    }
    estado.inicio = new Date(estado.inicio).toISOString();
    estado.vencimento = new Date(estado.vencimento).toISOString();
    if (estado.urgente_em) estado.urgente_em = new Date(estado.urgente_em).toISOString();
    if (card.labels?.some(l => M.normalizar(l.name) === 'urgente') && !estado.urgente_em && !acoes.length)
      acoes = await historico(id,'addLabelToCard');
    estado = M.limitarUrgencia(estado,card,acoes,agora());
    // Vencimento persistido antes de qualquer projeção; nunca depende do due editável.
    if (!cache.usuarios) {
      cache.usuarios = (await client.query('SELECT login,nome FROM usuarios')).rows;
      cache.escreventes = (await client.query('SELECT login,nome,board_id,ativo FROM escreventes')).rows;
    }
    const responsavel = require('./prazos-atos-painel').resolverResponsavel(card.idBoard,lista.name,cache.usuarios,cache.escreventes,estado.responsavel_login);
    const url = /^https:\/\/trello\.com\/c\/[a-zA-Z0-9]+(?:\/[^\s]*)?$/.test(card.shortUrl || '') ? card.shortUrl : null;
    await client.query(`UPDATE prazos_atos SET vencimento=$2,urgente_em=$3,board_id=$4,list_id=$5,estado=$6,
      responsavel_login=$7,card_url=COALESCE($8,card_url),atualizado_em=now() WHERE card_id=$1`,
      [id,estado.vencimento,estado.urgente_em,card.idBoard,card.idList,fase,responsavel,url]);
    const s = M.situacao(estado,agora());
    if (fase === 'concluido') {
      if (!await registrarConclusao(client,card,estado,reg,responsavel,card.idList)) throw Error('conclusao_sem_evidencia');
    }
    if (!cache.campos[card.idBoard]) cache.campos[card.idBoard] = await campos(card.idBoard);
    const live = await lerCard(id);
    if (live.idBoard !== card.idBoard || live.idList !== card.idList || live.closed !== card.closed) throw Error('cartao_em_movimentacao');
    card = live;
    if (card.cover?.size === 'full') {
      await client.query('UPDATE prazos_atos SET cover_original=COALESCE(cover_original,$2::jsonb) WHERE card_id=$1',[id,JSON.stringify(card.cover)]);
      await api('PUT',`/cards/${id}`,{ cover:{size:'normal'} });
      const depois = await lerCard(id);
      if (depois.cover?.size !== 'normal' || (depois.cover.color || null) !== (card.cover.color || null) ||
        (depois.cover.idAttachment || null) !== (card.cover.idAttachment || null) || depois.idBoard !== card.idBoard || depois.idList !== card.idList)
        throw Error('capa_nao_confirmada');
      card = depois;
    }
    await projetar(card,estado,s,fase,cache.campos[card.idBoard]);
    if (fase !== 'concluido') await avisar(client,card,estado,{...s,aviso:M.avisoDoDia(estado.vencimento,agora())});
    await client.query('UPDATE prazos_atos SET cor=$2,confirmado_em=now(),erro=NULL WHERE card_id=$1',[id,fase === 'concluido' ? 'concluido' : s.cor]);
    return fase;
  }
  async function registrarConclusao(client,card,estado,reg,responsavel,listaFinal=null) {
    const chave='ato:'+card.id;
    if ((await client.query('SELECT chave FROM prazos_metricas WHERE chave=$1',[chave])).rows.length) return true;
    const movimentos=await historico(card.id,'updateCard:idList,moveCardToBoard');
    const fim=movimentos.filter(a=>{
      const d=a.data||{},l=d.listAfter||d.list||{};
      return Date.parse(a.date)>=new Date(estado.inicio).getTime() &&
        (listaFinal ? M.chegada(a)?.lista===listaFinal : M.fase(l.name,false)==='concluido');
    }).sort((a,b)=>Date.parse(a.date)-Date.parse(b.date))[0];
    if(!fim)return false;
    await require('./prazos-metricas').registrar(client,{chave,tipo:'ato',card_id:card.id,protocolo:reg.numero,
      responsavel_login:responsavel,ato:estado.regra.ato,inicio:estado.inicio,vencimento:estado.vencimento,concluido_em:fim.date,evidencia:fim.id});
    return true;
  }
  async function executar({ cardIds, varrer = false } = {}) {
    if (!habilitado()) return { ativo:false };
    if (rodando) { for (const id of cardIds || []) fila.add(id); return { ocupado:true }; }
    rodando = true;
    let client, lock = false;
    const r = { iniciado_em:agora().toISOString(), confirmados:0, erros:0, estados:{} };
    try {
      client = await pool.connect();
      lock = (await client.query('SELECT pg_try_advisory_lock($1) AS ok',[LOCK])).rows[0]?.ok === true;
      if (!lock) return { ocupado:true };
      const boards = await quadros(), ids = new Set(cardIds || []);
      if (varrer) {
        // Descobre também eventos perdidos e cartões que saíram rapidamente do quadro 00.
        for (const board of boards) {
          const cards = await api('GET',`/boards/${board}/cards?fields=id&filter=open`);
          for (const c of cards) ids.add(c.id);
        }
        const ativos = await client.query("SELECT card_id FROM prazos_atos WHERE estado NOT IN ('concluido','arquivado','inacessivel')");
        for (const x of ativos.rows) ids.add(x.card_id);
      }
      const cache = { campos:{}, listas:{} };
      const ordenados=[...ids];
      for (let indice=0;indice<ordenados.length;indice++) {
        const id=ordenados[indice];
        if (!validarId(id)) continue;
        try { const e = await sincronizar(client,id,boards,cache); r.estados[e] = (r.estados[e] || 0) + 1; r.confirmados++; }
        catch (e) {
          r.erros++; r.ultimo_erro = erroSeguro(e);
          await client.query('UPDATE prazos_atos SET erro=$2,atualizado_em=now() WHERE card_id=$1',[id,r.ultimo_erro]);
          if (e.status === 404) await client.query("UPDATE prazos_atos SET estado='inacessivel' WHERE card_id=$1",[id]);
          if ([401,403,429].includes(e.status) || e.codigo === 'trello_timeout') {
            for(const pendente of ordenados.slice(indice))fila.add(pendente);
            break;
          }
        }
      }
      return r;
    } catch(e) { r.erros++; r.ultimo_erro = erroSeguro(e); return r; }
    finally {
      if (lock) await client.query('SELECT pg_advisory_unlock($1)',[LOCK]).catch(()=>{});
      client?.release(); rodando = false; ultimo = { ...r, terminado_em:agora().toISOString() };
    }
  }
  function disparar(op) { executar(op).then(r => { if(r.erros) log('[prazos-atos] ' + r.ultimo_erro); }).catch(()=>log('[prazos-atos] falha')); }
  function enfileirar(id) {
    if (!habilitado() || !iniciado || !validarId(id)) return;
    fila.add(id);
    if (!breve) { breve = setTimeout(()=>{ breve=null;const ids=[...fila];fila.clear();disparar({cardIds:ids}); },1500);breve.unref?.(); }
  }
  async function iniciar() {
    if (!habilitado() || iniciado) return false;
    await init(); iniciado=true;
    timer=setInterval(()=>{const ids=[...fila];fila.clear();disparar({cardIds:ids,varrer:true});},intervaloMs);
    timer.unref?.();disparar({varrer:true});return true;
  }
  function parar() { clearInterval(timer);clearTimeout(breve);timer=breve=null;iniciado=false;fila.clear(); }
  async function status() {
    const estados = iniciado ? (await pool.query('SELECT estado,cor,count(*)::int AS quantidade,max(confirmado_em) AS confirmado_em FROM prazos_atos GROUP BY estado,cor')).rows : [];
    return { versao:M.VERSAO,ativo:habilitado(),iniciado,rodando,intervalo_minutos:intervaloMs/60000,ultimo,estados };
  }
  const saude = () => ({ versao:M.VERSAO, ativo:habilitado(), iniciado,
    ultima_rodada:ultimo?.terminado_em || null, ultima_rodada_ok:ultimo ? ultimo.erros === 0 : null });
  return { init,iniciar,parar,enfileirar,executar,status,saude,historico,sincronizar };
}
module.exports = { ...criarServico(), criarServico, SCHEMA, CAMPOS };
