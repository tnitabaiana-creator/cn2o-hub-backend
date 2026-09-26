// db.js — Postgres: registro canônico de cada protocolo + numeração atômica
const { Pool } = require('pg');
const { hashToken } = require('./auth');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS protocolos (
      numero     INTEGER PRIMARY KEY,
      dados      JSONB NOT NULL,
      card_id    TEXT,
      criado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS contador (
      nome   TEXT PRIMARY KEY,
      valor  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usuarios (
      login       TEXT PRIMARY KEY,
      nome        TEXT NOT NULL,
      cargo       TEXT NOT NULL,
      senha_hash  TEXT,                          -- NULL = primeiro acesso pendente
      atualizado  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessoes (
      token   TEXT PRIMARY KEY,
      login   TEXT NOT NULL REFERENCES usuarios(login),
      criado  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expira  TIMESTAMPTZ NOT NULL
    );
    ALTER TABLE protocolos ADD COLUMN IF NOT EXISTS usuario TEXT;
    -- v1.39.1 (segurança): primeiro acesso só com código de uso único dado pelo Tabelião
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS codigo_hash TEXT;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS codigo_expira TIMESTAMPTZ;
    -- v1.39.1: a coluna token passa a guardar o SHA-256 do token (v2 = true). As sessões
    -- antigas, com o token em claro, são apagadas: todo mundo entra de novo uma vez.
    ALTER TABLE sessoes ADD COLUMN IF NOT EXISTS v2 BOOLEAN NOT NULL DEFAULT false;
    DELETE FROM sessoes WHERE v2 = false OR expira < now();
  `);
  // usuários da serventia (senha definida por cada um no primeiro acesso)
  const USUARIOS = [
    ['cesar.bravo',     'César Bravo', 'Tabelião'],
    ['josi.silva',      'Josilene',    'Substituta do Tabelião'],
    ['lara.silva',      'Lara',        'Escrevente'],
    ['romenia.oliveira','Romênia',     'Escrevente'],
    ['jonas.aragao',    'Jonas',       'Escrevente'],
    ['camily.jesus',    'Camily',      'Escrevente'],
    ['milvo.neto',      'Milvo',       'Chefe do Setor de Protocolo']
  ];
  for (const [login, nome, cargo] of USUARIOS) {
    await pool.query(
      `INSERT INTO usuarios (login, nome, cargo) VALUES ($1,$2,$3)
       ON CONFLICT (login) DO NOTHING`, [login, nome, cargo]);
  }
  // semente única do contador (último manual + 1, via env PROTOCOLO_INICIAL)
  await pool.query(
    `INSERT INTO contador (nome, valor) VALUES ('protocolo', $1)
     ON CONFLICT (nome) DO NOTHING`,
    [parseInt(process.env.PROTOCOLO_INICIAL || '1', 10)]
  );
}

// numeração atômica: UPDATE ... RETURNING garante ausência de furo/repetição
// mesmo com dois balcões protocolando no mesmo segundo
async function proximoNumero(client) {
  const r = await client.query(
    `UPDATE contador SET valor = valor + 1 WHERE nome='protocolo' RETURNING valor - 1 AS numero`
  );
  return r.rows[0].numero;
}

async function registrarProtocolo(dados, usuario) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const numero = await proximoNumero(client);
    await client.query(
      `INSERT INTO protocolos (numero, dados, usuario) VALUES ($1, $2, $3)`,
      [numero, dados, usuario || null]
    );
    await client.query('COMMIT');
    return numero;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function vincularCartao(numero, cardId) {
  await pool.query(`UPDATE protocolos SET card_id=$2 WHERE numero=$1`, [numero, cardId]);
}

async function protocoloPorCartao(cardId) {
  const r = await pool.query(`SELECT numero, dados FROM protocolos WHERE card_id=$1`, [cardId]);
  return r.rows[0] || null;
}

async function buscarUsuario(login) {
  const r = await pool.query(`SELECT * FROM usuarios WHERE login=$1`, [String(login||'').trim().toLowerCase()]);
  return r.rows[0] || null;
}
async function gravarSenha(login, hash) {
  await pool.query(`UPDATE usuarios SET senha_hash=$2, atualizado=now() WHERE login=$1`, [login, hash]);
}
// v1.39.1: no banco fica só o SHA-256 do token (hashToken); o token em si vive no navegador.
async function criarSessao(token, login, horas = 12) {
  await pool.query(`DELETE FROM sessoes WHERE expira < now()`);          // faxina das vencidas
  await pool.query(`INSERT INTO sessoes (token, login, expira, v2) VALUES ($1,$2, now() + ($3 || ' hours')::interval, true)`,
    [hashToken(token), login, String(horas)]);
}
async function sessaoValida(token) {
  if (!token) return null;
  const r = await pool.query(
    `SELECT s.login, u.nome, u.cargo FROM sessoes s JOIN usuarios u ON u.login=s.login
     WHERE s.token=$1 AND s.v2 AND s.expira > now()`, [hashToken(token)]);
  return r.rows[0] || null;
}
async function encerrarSessao(token) {
  await pool.query(`DELETE FROM sessoes WHERE token=$1`, [hashToken(token)]);
}
async function encerrarSessoesDe(login) {
  await pool.query(`DELETE FROM sessoes WHERE login=$1`, [login]);
}
// v1.39.1 — código de primeiro acesso: zera a senha, derruba as sessões e deixa um
// código de uso único (só o hash) com validade.
async function gravarCodigo(login, codigoHash, horas = 48) {
  await pool.query(
    `UPDATE usuarios SET senha_hash=NULL, codigo_hash=$2, codigo_expira=now() + ($3 || ' hours')::interval, atualizado=now()
      WHERE login=$1`, [login, codigoHash, String(horas)]);
  await encerrarSessoesDe(login);
}
// Grava a senha SÓ se a conta está sem senha e o código confere e não venceu — tudo num
// UPDATE só (sem janela entre conferir e gravar). Devolve a pessoa, ou null.
async function definirSenhaComCodigo(login, codigoHash, senhaHash) {
  const r = await pool.query(
    `UPDATE usuarios SET senha_hash=$3, codigo_hash=NULL, codigo_expira=NULL, atualizado=now()
      WHERE login=$1 AND senha_hash IS NULL AND codigo_hash IS NOT NULL AND codigo_hash=$2 AND codigo_expira > now()
      RETURNING login, nome, cargo`, [login, codigoHash, senhaHash]);
  return r.rows[0] || null;
}

module.exports = { init, registrarProtocolo, vincularCartao, protocoloPorCartao, pool,
  buscarUsuario, gravarSenha, criarSessao, sessaoValida, encerrarSessao, encerrarSessoesDe,
  gravarCodigo, definirSenhaComCodigo };
