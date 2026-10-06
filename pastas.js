'use strict';
// pastas.js — Ficheiro de Pastas (v1.44; v1.44.2: arquivar/excluir o cartão libera a pasta)
//
// Pastas fixas numeradas (001 a 300) para os protocolos de escrituras. Todo cartão de
// protocolo que entra numa lista de trabalho recebe a próxima pasta do GIRO CIRCULAR
// (segue até 300 e volta ao 001, pulando as ocupadas); o cartão ganha o campo "Pasta" e
// o comentário "📁 Guardar na PASTA nnn". A pasta volta ao montante quando o cartão entra
// em "Arquivo Geral" ou "Escrituras Sem Efeito" no quadro 00, ou quando o cartão é
// ARQUIVADO (ou excluído) no Trello, em qualquer quadro. Os 27 protocolos antigos
// (decisão do Tabelião, out/2026) ficam fora da numeração. Nada é atribuído antes da
// carga inicial, feita pelo Tabelião no quadro do Hub.
//
// Módulo separado: tabelas próprias (pastas, pastas_config, pastas_historico,
// pastas_excluidos, pastas_campos), rotas /hub/pastas e um gancho no webhook do Trello
// que já existe no server.js. Nenhuma outra parte do backend depende dele.

const express = require('express');
const db = require('./db');

const log = console;

// ===== Núcleo: banco e giro circular =====
const TOTAL_INICIAL = 300;
const ALERTA_PCT = 85;

// Protocolos antigos que ficam FORA da numeração (decisão do Tabelião, out/2026).
const EXCLUIDOS_INICIAIS = [
  494, 606, 660, 695, 741, 852, 1049, 1086, 1138, // 01. TABELIÃO
  848, 894, 895, 924, 951, 998,                   // Jonas
  263, 264, 435, 897, 1082,                       // Romênia
  76, 1063, 1111, 1142,                           // Lara
  829, 1077,                                      // Josilene
  1028,                                           // Camily
];

const fmtPasta = (n) => String(n).padStart(3, '0');
const fmtProt = (n) => String(n).padStart(4, '0');

async function init(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS pastas (
    numero     INTEGER PRIMARY KEY,
    protocolo  INTEGER UNIQUE,
    card_id    TEXT,
    ocupada_em TIMESTAMPTZ)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS pastas_config (
    id         INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    total      INTEGER NOT NULL,
    ponteiro   INTEGER NOT NULL DEFAULT 0,
    alerta_pct INTEGER NOT NULL DEFAULT ${ALERTA_PCT})`);
  await pool.query(`CREATE TABLE IF NOT EXISTS pastas_historico (
    id        SERIAL PRIMARY KEY,
    numero    INTEGER NOT NULL,
    protocolo INTEGER NOT NULL,
    card_id   TEXT,
    evento    TEXT NOT NULL,          -- 'ocupada' | 'liberada'
    motivo    TEXT,
    por       TEXT,
    em        TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS pastas_excluidos (
    protocolo INTEGER PRIMARY KEY,
    motivo    TEXT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS pastas_campos (
    board_id TEXT PRIMARY KEY,
    field_id TEXT NOT NULL)`);

  await pool.query('ALTER TABLE pastas_config ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT false');
  await pool.query(
    `INSERT INTO pastas_config (id, total) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
    [TOTAL_INICIAL]);
  const { rows } = await pool.query('SELECT total FROM pastas_config WHERE id = 1');
  await garantirPastas(pool, rows[0].total);

  for (const p of EXCLUIDOS_INICIAIS) {
    await pool.query(
      `INSERT INTO pastas_excluidos (protocolo, motivo) VALUES ($1, 'antigo — fora da numeração')
       ON CONFLICT (protocolo) DO NOTHING`, [p]);
  }
}

async function garantirPastas(db, total) {
  const { rows } = await db.query('SELECT COALESCE(MAX(numero), 0) AS max FROM pastas');
  const de = Number(rows[0].max) + 1;
  if (de > total) return;
  const valores = [];
  for (let n = de; n <= total; n++) valores.push(`(${n})`);
  await db.query(`INSERT INTO pastas (numero) VALUES ${valores.join(',')} ON CONFLICT DO NOTHING`);
}

async function transacao(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Reserva a próxima pasta do giro para um protocolo.
 * Retorna { status: 'ok' | 'ja_tinha' | 'excluido' | 'cheio', numero?, pasta? }
 * Idempotente: chamar duas vezes para o mesmo protocolo devolve a mesma pasta.
 */
async function reservar(pool, { protocolo, cardId = null, por = null }) {
  protocolo = Number(protocolo);
  if (!Number.isInteger(protocolo) || protocolo <= 0) throw new Error('protocolo inválido');

  return transacao(pool, async (db) => {
    // A trava na linha de configuração enfileira reservas simultâneas (duas escreventes
    // protocolando no mesmo segundo nunca recebem a mesma pasta).
    const cfg = (await db.query(
      'SELECT total, ponteiro FROM pastas_config WHERE id = 1 FOR UPDATE')).rows[0];

    const ex = await db.query('SELECT 1 FROM pastas_excluidos WHERE protocolo = $1', [protocolo]);
    if (ex.rowCount) return { status: 'excluido' };

    const ja = await db.query('SELECT numero FROM pastas WHERE protocolo = $1', [protocolo]);
    if (ja.rowCount) {
      const numero = ja.rows[0].numero;
      if (cardId) await db.query('UPDATE pastas SET card_id = $1 WHERE numero = $2', [cardId, numero]);
      return { status: 'ja_tinha', numero, pasta: fmtPasta(numero) };
    }

    // Giro: primeiro a próxima livre DEPOIS do ponteiro; se não houver, volta ao início.
    let livre = await db.query(
      `SELECT numero FROM pastas
        WHERE protocolo IS NULL AND numero > $1 AND numero <= $2
        ORDER BY numero LIMIT 1`, [cfg.ponteiro, cfg.total]);
    if (!livre.rowCount) {
      livre = await db.query(
        `SELECT numero FROM pastas
          WHERE protocolo IS NULL AND numero <= $1
          ORDER BY numero LIMIT 1`, [Math.min(cfg.ponteiro, cfg.total)]);
    }
    if (!livre.rowCount) return { status: 'cheio' };

    const numero = livre.rows[0].numero;
    await db.query(
      'UPDATE pastas SET protocolo = $1, card_id = $2, ocupada_em = now() WHERE numero = $3',
      [protocolo, cardId, numero]);
    await db.query('UPDATE pastas_config SET ponteiro = $1 WHERE id = 1', [numero]);
    await db.query(
      `INSERT INTO pastas_historico (numero, protocolo, card_id, evento, motivo, por)
       VALUES ($1, $2, $3, 'ocupada', 'protocolo', $4)`, [numero, protocolo, cardId, por]);
    return { status: 'ok', numero, pasta: fmtPasta(numero) };
  });
}

/**
 * Libera a pasta de um protocolo (por cardId ou número do protocolo).
 * Retorna { status: 'liberada' | 'sem_pasta', numero?, pasta?, protocolo? }
 */
async function liberar(pool, { cardId = null, protocolo = null, motivo = null, por = null }) {
  return transacao(pool, async (db) => {
    const r = cardId
      ? await db.query('SELECT numero, protocolo, card_id FROM pastas WHERE card_id = $1 FOR UPDATE', [cardId])
      : await db.query('SELECT numero, protocolo, card_id FROM pastas WHERE protocolo = $1 FOR UPDATE', [Number(protocolo)]);
    if (!r.rowCount) return { status: 'sem_pasta' };
    const p = r.rows[0];
    await db.query(
      'UPDATE pastas SET protocolo = NULL, card_id = NULL, ocupada_em = NULL WHERE numero = $1',
      [p.numero]);
    await db.query(
      `INSERT INTO pastas_historico (numero, protocolo, card_id, evento, motivo, por)
       VALUES ($1, $2, $3, 'liberada', $4, $5)`, [p.numero, p.protocolo, p.card_id, motivo, por]);
    return { status: 'liberada', numero: p.numero, pasta: fmtPasta(p.numero), protocolo: p.protocolo };
  });
}

/** O serviço só atribui/libera pastas depois da carga inicial. */
async function estaAtivo(pool) {
  const r = await pool.query('SELECT ativo FROM pastas_config WHERE id = 1');
  return !!(r.rowCount && r.rows[0].ativo);
}

async function ocupacao(pool) {
  const cfg = (await pool.query('SELECT total, ponteiro, alerta_pct, ativo FROM pastas_config WHERE id = 1')).rows[0];
  const occ = Number((await pool.query(
    'SELECT COUNT(*) AS n FROM pastas WHERE protocolo IS NOT NULL AND numero <= $1', [cfg.total])).rows[0].n);
  const pct = Math.round((occ / cfg.total) * 1000) / 10;
  return {
    total: cfg.total, ocupadas: occ, livres: cfg.total - occ, percentual: pct,
    alerta: pct >= cfg.alerta_pct, alerta_pct: cfg.alerta_pct,
    ultima_entregue: cfg.ponteiro ? fmtPasta(cfg.ponteiro) : null,
    ativo: cfg.ativo,
  };
}

async function listar(pool) {
  const { rows } = await pool.query(
    `SELECT p.numero, p.protocolo, p.card_id, p.ocupada_em
       FROM pastas p, pastas_config c
      WHERE c.id = 1 AND p.numero <= c.total
      ORDER BY p.numero`);
  return rows.map((r) => ({
    pasta: fmtPasta(r.numero),
    protocolo: r.protocolo ? fmtProt(r.protocolo) : null,
    card_id: r.card_id, ocupada_em: r.ocupada_em,
  }));
}

async function porProtocolo(pool, protocolo) {
  const n = Number(protocolo);
  const r = await pool.query('SELECT numero, card_id, ocupada_em FROM pastas WHERE protocolo = $1', [n]);
  if (r.rowCount) return { protocolo: fmtProt(n), pasta: fmtPasta(r.rows[0].numero), ...r.rows[0] };
  const ex = await pool.query('SELECT 1 FROM pastas_excluidos WHERE protocolo = $1', [n]);
  return { protocolo: fmtProt(n), pasta: null, excluido: ex.rowCount > 0 };
}

async function porPasta(pool, numero) {
  const r = await pool.query('SELECT numero, protocolo, card_id, ocupada_em FROM pastas WHERE numero = $1', [Number(numero)]);
  if (!r.rowCount) return null;
  const p = r.rows[0];
  return { pasta: fmtPasta(p.numero), protocolo: p.protocolo ? fmtProt(p.protocolo) : null,
           card_id: p.card_id, ocupada_em: p.ocupada_em };
}

async function porCard(pool, cardId) {
  const r = await pool.query('SELECT numero, protocolo FROM pastas WHERE card_id = $1', [cardId]);
  return r.rowCount ? { numero: r.rows[0].numero, pasta: fmtPasta(r.rows[0].numero), protocolo: r.rows[0].protocolo } : null;
}

/** Amplia o ficheiro (ex.: 300 → 400). Nunca reduz. */
async function ampliar(pool, novoTotal) {
  novoTotal = Number(novoTotal);
  return transacao(pool, async (db) => {
    const cfg = (await db.query('SELECT total FROM pastas_config WHERE id = 1 FOR UPDATE')).rows[0];
    if (!Number.isInteger(novoTotal) || novoTotal <= cfg.total) {
      throw new Error(`o novo total precisa ser maior que ${cfg.total}`);
    }
    await garantirPastas(db, novoTotal);
    await db.query('UPDATE pastas_config SET total = $1 WHERE id = 1', [novoTotal]);
    return { total_anterior: cfg.total, total: novoTotal };
  });
}

/**
 * Carga inicial: distribui os protocolos ativos nas pastas 001..N, em ordem crescente
 * de protocolo, e deixa o giro começando em N+1. Só roda com o ficheiro vazio.
 * itens: [{ protocolo, cardId }]
 */
async function cargaInicial(pool, itens, { por = 'carga inicial' } = {}) {
  return transacao(pool, async (db) => {
    const cfg = (await db.query('SELECT total FROM pastas_config WHERE id = 1 FOR UPDATE')).rows[0];
    const occ = Number((await db.query('SELECT COUNT(*) AS n FROM pastas WHERE protocolo IS NOT NULL')).rows[0].n);
    if (occ > 0) throw new Error(`a carga inicial exige o ficheiro vazio (há ${occ} pastas ocupadas)`);

    const excl = new Set((await db.query('SELECT protocolo FROM pastas_excluidos')).rows.map((r) => r.protocolo));
    const vistos = new Set();
    const lista = [];
    for (const it of itens) {
      const p = Number(it.protocolo);
      if (!Number.isInteger(p) || excl.has(p) || vistos.has(p)) continue;
      vistos.add(p);
      lista.push({ protocolo: p, cardId: it.cardId || null });
    }
    lista.sort((a, b) => a.protocolo - b.protocolo);
    if (lista.length > cfg.total) {
      throw new Error(`${lista.length} protocolos não cabem em ${cfg.total} pastas — amplie antes`);
    }

    const distribuicao = [];
    for (let i = 0; i < lista.length; i++) {
      const numero = i + 1;
      const { protocolo, cardId } = lista[i];
      await db.query('UPDATE pastas SET protocolo = $1, card_id = $2, ocupada_em = now() WHERE numero = $3',
        [protocolo, cardId, numero]);
      await db.query(
        `INSERT INTO pastas_historico (numero, protocolo, card_id, evento, motivo, por)
         VALUES ($1, $2, $3, 'ocupada', 'carga inicial', $4)`, [numero, protocolo, cardId, por]);
      distribuicao.push({ pasta: fmtPasta(numero), protocolo: fmtProt(protocolo), cardId });
    }
    // A partir daqui o serviço passa a atribuir pastas automaticamente.
    await db.query('UPDATE pastas_config SET ponteiro = $1, ativo = true WHERE id = 1', [lista.length]);
    return distribuicao;
  });
}

/** Relação para a conferência semanal: pastas ocupadas, com dias de ocupação. */
async function conferencia(pool) {
  const { rows } = await pool.query(
    `SELECT numero, protocolo, card_id, ocupada_em,
            FLOOR(EXTRACT(EPOCH FROM (now() - ocupada_em)) / 86400)::int AS dias
       FROM pastas WHERE protocolo IS NOT NULL ORDER BY numero`);
  return rows.map((r) => ({ pasta: fmtPasta(r.numero), protocolo: fmtProt(r.protocolo),
                            card_id: r.card_id, ocupada_em: r.ocupada_em, dias: r.dias }));
}


// ===== Trello: campo "Pasta", leitura do protocolo, webhook e carga inicial =====
const API = 'https://api.trello.com/1';
const NOME_CAMPO = 'Pasta';

const QUADRO_00 = '692e0379fa55156e778f27ef';           // 00. Protocolo/Cadastro
const LISTAS_QUE_LIBERAM = ['Arquivo Geral', 'Escrituras Sem Efeito']; // nome EXATO, só no quadro 00

// Os 7 quadros do fluxo de escrituras.
const QUADROS = {
  '692e0379fa55156e778f27ef': '00. Protocolo/Cadastro',
  '692e06a94b807c2a1816d992': '01. TABELIÃO',
  '692e076f5485a0cbb533fe61': 'Josilene',
  '692e084cec9c0b8b5eb304d3': 'Camily',
  '692e095e6ca879a15d5ee852': 'Romênia',
  '692e0a12a6941ed8d023177f': 'Lara',
  '69ee446f4480af4b9688554a': 'Jonas',
};

// Listas do quadro 00 que NÃO são protocolos ativos (arquivo / sem efeito).
const LISTAS_INATIVAS_00 = [
  'Escrituras Sem Efeito', 'Arquivo Geral', 'Arquivo (Livros 888<)',
  'Arquivo Geral 2 (Cartões identificados)', 'Arquivado ✔',
  'Arquivamento • revisar (anexo grande)', 'Arquivo de Certidões/Traslado',
  'Arquivamento • refazer (PDF trocado)',
];

const norm = (s) => String(s || '').trim();
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Número do protocolo a partir do cartão.
 * 1º) bloco <!--DADOS {...} DADOS--> que o Hub grava na descrição (campo "numero");
 * 2º) título: ignora o que está entre parênteses e os números "Extra"/"PROT.EXTRA"/"E.".
 */
function extrairProtocolo({ name = '', desc = '' } = {}) {
  const m = String(desc).match(/<!--DADOS\s*([\s\S]*?)\s*DADOS-->/);
  if (m) {
    try {
      const n = Number(JSON.parse(m[1]).numero);
      if (Number.isInteger(n) && n > 0) return n;
    } catch (_) { /* cai para o título */ }
  }
  if (!/^\s*prot/i.test(name)) return null;
  const t = String(name)
    .replace(/\([^)]*\)/g, ' ')                               // (CV-Urbano), (CDHC-Minut. 2423)…
    .replace(/(prot\.?\s*)?extra[\s:.;-]*\d+/gi, ' ')         // Extra 1342, PROT.EXTRA 1884, Extra: 2028
    .replace(/\bE\.\s*\d+/g, ' ')                             // E. 1803
    .replace(/^\s*prot\.?/i, ' ');
  const n = t.match(/(?:^|[^\d.])(\d{3,4})(?![\d.])/);
  return n ? parseInt(n[1], 10) : null;
}

async function trello(method, path, body) {
  const key = process.env.TRELLO_KEY, token = process.env.TRELLO_TOKEN;
  if (!key || !token) throw new Error('TRELLO_KEY/TRELLO_TOKEN ausentes');
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${API}${path}${sep}key=${key}&token=${token}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) { await esperar(1500); return trello(method, path, body); }
  if (!res.ok) throw new Error(`Trello ${method} ${path} → ${res.status} ${await res.text()}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

/** ID do campo "Pasta" no quadro; cria o campo (visível na frente do cartão) se não existir. */
async function campoDoQuadro(pool, boardId) {
  const c = await pool.query('SELECT field_id FROM pastas_campos WHERE board_id = $1', [boardId]);
  if (c.rowCount) return c.rows[0].field_id;
  const campos = await trello('GET', `/boards/${boardId}/customFields`);
  let campo = (Array.isArray(campos) ? campos : []).find((f) => norm(f.name) === NOME_CAMPO);
  if (!campo) {
    campo = await trello('POST', '/customFields', {
      idModel: boardId, modelType: 'board', name: NOME_CAMPO,
      type: 'text', pos: 'top', display_cardFront: true,
    });
  }
  if (!campo || !campo.id) throw new Error(`não foi possível criar/achar o campo "${NOME_CAMPO}" no quadro ${boardId}`);
  await pool.query(
    `INSERT INTO pastas_campos (board_id, field_id) VALUES ($1, $2)
     ON CONFLICT (board_id) DO UPDATE SET field_id = EXCLUDED.field_id`, [boardId, campo.id]);
  return campo.id;
}

/** Grava (ou limpa, com numero = null) o campo "Pasta" do cartão. */
async function gravarCampo(pool, { cardId, boardId, numero }) {
  const fieldId = await campoDoQuadro(pool, boardId);
  const body = numero
    ? { value: { text: fmtPasta(numero) } }
    : { value: '', idValue: '' };
  await trello('PUT', `/cards/${cardId}/customField/${fieldId}/item`, body);
}

async function comentar(cardId, texto) {
  await trello('POST', `/cards/${cardId}/actions/comments`, { text: texto });
}

/**
 * Reserva a pasta do protocolo, grava o campo "Pasta" e comenta no cartão.
 * Falha no Trello NÃO desfaz a reserva (o banco é a fonte da verdade).
 */
async function atribuirPasta(pool, { protocolo, cardId, boardId = QUADRO_00, por = null, log = console }) {
  const r = await reservar(pool, { protocolo, cardId, por });
  try {
    if (r.status === 'ok' || r.status === 'ja_tinha') {
      await gravarCampo(pool, { cardId, boardId, numero: r.numero });
      if (r.status === 'ok') await comentar(cardId, `📁 Guardar na PASTA ${r.pasta}`);
    } else if (r.status === 'cheio') {
      await comentar(cardId, '⚠ SEM PASTA — o ficheiro está cheio. Avisar o Tabelião.');
    }
  } catch (e) {
    log.error('[pastas] reserva feita, mas falhou gravar no Trello:', e.message);
    r.aviso_trello = e.message;
  }
  return r;
}

// Listas do quadro 00 onde o cartão ainda NÃO tem papel no ficheiro.
const LISTAS_SEM_PASTA_00 = [...LISTAS_INATIVAS_00, 'Pré-protocolo (Site)'];

/** O cartão está numa lista de trabalho (onde o protocolo ocupa pasta)? */
function listaAtiva(boardId, nomeLista) {
  if (!QUADROS[boardId]) return false;
  const n = norm(nomeLista);
  if (!n || n.startsWith('⚙')) return false;
  if (boardId === QUADRO_00 && LISTAS_SEM_PASTA_00.includes(n)) return false;
  return true;
}

/**
 * Trata uma ação recebida no webhook do Trello. Seguro para receber a mesma ação
 * mais de uma vez (o webhook de cada quadro dispara a sua cópia).
 *
 * - Entrou em "Arquivo Geral" / "Escrituras Sem Efeito" (quadro 00) → libera a pasta.
 * - Cartão de protocolo criado, movido, renomeado ou vindo de outro quadro e que está
 *   numa lista de trabalho sem pasta → recebe a próxima pasta do giro.
 * - Cartão com pasta mudou de quadro → repõe o campo "Pasta" no quadro novo.
 * Nada acontece antes da carga inicial (serviço inativo).
 */
async function processarAcao(pool, action, { log = console } = {}) {
  if (!action || !action.data || !action.data.card) return { ignorada: true };
  const { type } = action;
  const d = action.data;
  const cardId = d.card.id;
  const boardId = d.board && d.board.id;
  const por = action.memberCreator && action.memberCreator.fullName;

  const mudouLista = type === 'updateCard' && d.listAfter;
  const renomeou = type === 'updateCard' && d.old && Object.prototype.hasOwnProperty.call(d.old, 'name');
  const mudouArquivo = type === 'updateCard' && d.old && Object.prototype.hasOwnProperty.call(d.old, 'closed');
  const arquivou = mudouArquivo && d.card.closed === true;
  const desarquivou = mudouArquivo && d.card.closed === false;
  const excluiu = type === 'deleteCard';
  const relevante = type === 'createCard' || type === 'moveCardToBoard' || mudouLista || renomeou
    || arquivou || desarquivou || excluiu;
  if (!relevante) return { ignorada: true };
  if (!(await estaAtivo(pool))) return { ignorada: true, motivo: 'aguardando carga inicial' };

  // 0) Cartão arquivado (Arquivar do Trello, em qualquer quadro) ou excluído: a pasta volta
  //    ao montante. Desarquivado: segue para a regra 3 e, se estiver numa lista de trabalho,
  //    recebe a próxima pasta do giro.
  if (arquivou || excluiu) {
    const motivo = arquivou ? 'cartão arquivado' : 'cartão excluído';
    const r = await liberar(pool, { cardId, motivo, por });
    if (r.status === 'liberada' && arquivou && boardId) {
      try {
        await gravarCampo(pool, { cardId, boardId, numero: null });
        const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Maceio' });
        await comentar(cardId, `📁 Pasta ${r.pasta} liberada em ${hoje} (cartão arquivado).`);
      } catch (e) { log.error('[pastas] liberada, mas falhou atualizar o cartão arquivado:', e.message); }
    }
    return { acao: 'liberar', ...r };
  }

  // 1) Liberação: entrou em "Arquivo Geral" ou "Escrituras Sem Efeito" no quadro 00.
  const listaDestino = mudouLista ? norm(d.listAfter.name)
    : (type === 'moveCardToBoard' && d.list) ? norm(d.list.name) : null;
  if (listaDestino && boardId === QUADRO_00 && LISTAS_QUE_LIBERAM.includes(listaDestino)) {
    const r = await liberar(pool, { cardId, motivo: listaDestino, por });
    if (r.status === 'liberada') {
      try {
        await gravarCampo(pool, { cardId, boardId, numero: null });
        const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Maceio' });
        await comentar(cardId, `📁 Pasta ${r.pasta} liberada em ${hoje} (${listaDestino}).`);
      } catch (e) { log.error('[pastas] liberada, mas falhou atualizar o cartão:', e.message); }
    }
    return { acao: 'liberar', ...r };
  }

  // 2) Cartão que já tem pasta mudou de quadro: repõe o campo no quadro novo.
  const atual = await porCard(pool, cardId);
  if (atual) {
    if (type === 'moveCardToBoard' && boardId) {
      try { await gravarCampo(pool, { cardId, boardId, numero: atual.numero }); }
      catch (e) { log.error('[pastas] falhou repor o campo no novo quadro:', e.message); }
      return { acao: 'repor_campo', ...atual };
    }
    return { ignorada: true, motivo: 'já tem pasta' };
  }

  // 3) Cartão sem pasta numa lista de trabalho: atribui a próxima do giro.
  const card = await trello('GET', `/cards/${cardId}?fields=name,desc,idBoard&list=true&list_fields=name`);
  if (!card || !listaAtiva(card.idBoard, card.list && card.list.name)) {
    return { ignorada: true, motivo: 'lista sem pasta' };
  }
  const protocolo = extrairProtocolo(card);
  if (!protocolo) return { ignorada: true, motivo: 'título sem número de protocolo' };
  const r = await atribuirPasta(pool, { protocolo, cardId, boardId: card.idBoard, por, log });
  return { acao: 'reservar', protocolo, ...r };
}

/**
 * Lê os 7 quadros e devolve os protocolos ativos (fora das listas de arquivo e das
 * listas "⚙" de cadastro), já sem os excluídos. Usado na carga inicial.
 */
async function coletarAtivos(pool) {
  const excl = new Set((await pool.query('SELECT protocolo FROM pastas_excluidos')).rows.map((r) => r.protocolo));
  const ativos = [], semNumero = [], duplicados = [], vistos = new Map();
  for (const [boardId, quadro] of Object.entries(QUADROS)) {
    const listas = await trello('GET', `/boards/${boardId}/lists?filter=open&cards=open&card_fields=name,desc`);
    for (const lista of listas) {
      const nome = norm(lista.name);
      if (nome.startsWith('⚙')) continue;
      if (boardId === QUADRO_00 && LISTAS_INATIVAS_00.includes(nome)) continue;
      for (const card of lista.cards || []) {
        const protocolo = extrairProtocolo(card);
        if (!protocolo) {
          if (/^\s*prot/i.test(card.name)) semNumero.push({ quadro, lista: nome, titulo: card.name, cardId: card.id });
          continue;
        }
        if (excl.has(protocolo)) continue;
        if (vistos.has(protocolo)) {
          duplicados.push({ protocolo, quadro, lista: nome, titulo: card.name, cardId: card.id });
          continue;
        }
        vistos.set(protocolo, true);
        ativos.push({ protocolo, cardId: card.id, boardId, quadro, lista: nome, titulo: card.name });
      }
    }
  }
  ativos.sort((a, b) => a.protocolo - b.protocolo);
  return { ativos, semNumero, duplicados };
}

/**
 * Carga inicial completa. Com simular = true só mostra a distribuição, sem gravar nada.
 */
async function executarCargaInicial(pool, { simular = true, por = 'carga inicial', log = console } = {}) {
  const { ativos, semNumero, duplicados } = await coletarAtivos(pool);
  const previa = ativos.map((a, i) => ({ pasta: fmtPasta(i + 1), protocolo: fmtProt(a.protocolo),
                                         quadro: a.quadro, lista: a.lista, titulo: a.titulo }));
  if (simular) return { simulacao: true, total: ativos.length, distribuicao: previa, semNumero, duplicados };

  await cargaInicial(pool, ativos.map((a) => ({ protocolo: a.protocolo, cardId: a.cardId })), { por });
  const falhas = [];
  for (let i = 0; i < ativos.length; i++) {
    const a = ativos[i];
    try { await gravarCampo(pool, { cardId: a.cardId, boardId: a.boardId, numero: i + 1 }); }
    catch (e) { falhas.push({ protocolo: a.protocolo, erro: e.message }); }
    await esperar(120); // respeita o limite de requisições do Trello
  }
  if (falhas.length) log.error('[pastas] campos não gravados:', falhas);
  return { simulacao: false, total: ativos.length, distribuicao: previa, semNumero, duplicados, falhas };
}


// ---------------------------------------------------------------------------
// Rotas /hub/pastas (sessão do Hub; carga inicial, liberação e ampliação: Tabelião)
// ---------------------------------------------------------------------------
let PRONTO = null;
function pronto() {
  if (!PRONTO) PRONTO = init(db.pool).catch((e) => { PRONTO = null; throw e; });
  return PRONTO;
}
const ehAdmin = (u) => { try { return !!require('./hub').ehAdmin(u); } catch (_) { return false; } };

const router = express.Router();
router.use(express.json({ limit: '1mb' }));
router.use(async (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    const u = await db.sessaoValida(req.get('X-Auth-Token'));
    if (!u) return res.status(401).json({ erro: 'Entre no Hub CN2O para abrir o Ficheiro de Pastas.' });
    req.usuario = u;
    await pronto();
    next();
  } catch (e) {
    log.error('[pastas] sessão/banco:', e.message);
    res.status(503).json({ erro: 'Não foi possível abrir o Ficheiro de Pastas agora.' });
  }
});
const soTabeliao = (req, res, next) => (ehAdmin(req.usuario) ? next()
  : res.status(403).json({ erro: 'Função reservada ao Tabelião.' }));
const h = (fn) => (req, res) => fn(req, res).catch((e) => {
  log.error('[pastas]', e.message);
  res.status(500).json({ erro: e.message });
});
const nomeDe = (u) => (u && (u.nome || u.login)) || null;

router.get('/', h(async (req, res) => {
  res.json({ ocupacao: await ocupacao(db.pool), pastas: await listar(db.pool), admin: ehAdmin(req.usuario) });
}));
router.get('/protocolo/:n', h(async (req, res) => res.json(await porProtocolo(db.pool, req.params.n))));
router.get('/pasta/:numero', h(async (req, res) => {
  const p = await porPasta(db.pool, req.params.numero);
  if (!p) return res.status(404).json({ erro: 'pasta inexistente' });
  res.json(p);
}));
router.get('/conferencia', h(async (req, res) => {
  const linhas = await conferencia(db.pool);
  if (req.query.formato !== 'csv') return res.json({ ocupacao: await ocupacao(db.pool), pastas: linhas });
  const csv = ['pasta;protocolo;dias_na_pasta', ...linhas.map((l) => `${l.pasta};${l.protocolo};${l.dias}`)].join('\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="conferencia-pastas.csv"');
  res.send('\uFEFF' + csv);
}));
// { simular: true } mostra a prévia; { simular: false, confirmar: "CARGA" } grava.
router.post('/carga-inicial', soTabeliao, h(async (req, res) => {
  const simular = !(req.body && req.body.simular === false);
  if (!simular && !(req.body && req.body.confirmar === 'CARGA')) {
    return res.status(400).json({ erro: 'para executar, envie { simular: false, confirmar: "CARGA" }' });
  }
  res.json(await executarCargaInicial(db.pool, { simular, por: nomeDe(req.usuario) || 'carga inicial', log }));
}));
router.post('/liberar', soTabeliao, h(async (req, res) => {
  const { protocolo, motivo } = req.body || {};
  res.json(await liberar(db.pool, { protocolo, motivo: motivo || 'correção manual', por: nomeDe(req.usuario) }));
}));
router.post('/ampliar', soTabeliao, h(async (req, res) => res.json(await ampliar(db.pool, req.body && req.body.total))));

// Chamado pelo POST /webhook/trello do server.js (já com a assinatura conferida).
// Não bloqueia a resposta ao Trello; erros só vão para o log.
function aoWebhook(action) {
  pronto()
    .then(() => processarAcao(db.pool, action, { log }))
    .then((r) => { if (r && !r.ignorada) log.info('[pastas]', JSON.stringify(r)); })
    .catch((e) => log.error('[pastas] webhook:', e.message));
}

module.exports = {
  router, aoWebhook,
  // uso interno e testes
  _interno: { init, reservar, liberar, ocupacao, listar, porProtocolo, porPasta, porCard, ampliar,
    cargaInicial, conferencia, estaAtivo, extrairProtocolo, processarAcao, atribuirPasta,
    coletarAtivos, executarCargaInicial, QUADRO_00, QUADROS },
};
