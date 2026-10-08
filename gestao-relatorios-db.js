'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const CHAVE = 'produtividade-escrituras-v3';
const MAX_BYTES = 2 * 1024 * 1024;
const inicializacoes = new WeakMap();
const erro = (status, codigo, mensagem) => Object.assign(new Error(mensagem), { status, codigo });
const hash = dados => createHash('sha256').update(dados).digest('hex');

function init(pool) {
  if (!inicializacoes.has(pool)) inicializacoes.set(pool, (async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtext('cn2o-gestao-relatorios-v1'))");
      await c.query(await fs.readFile(path.join(__dirname, 'migrations', '20261008-gestao-relatorios.sql'), 'utf8'));
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  })().catch(e => { inicializacoes.delete(pool); throw e; }));
  return inicializacoes.get(pool);
}

function validarHTML(dados) {
  if (!Buffer.isBuffer(dados) || dados.length === 0) throw erro(400, 'HTML_INVALIDO', 'arquivo HTML vazio ou inválido');
  if (dados.length > MAX_BYTES) throw erro(413, 'ARQUIVO_GRANDE', 'o HTML deve ter até 2 MiB');
  const html = dados.toString('utf8');
  if (!Buffer.from(html, 'utf8').equals(dados) || html.includes('\0') || !/<html(?:\s|>)/i.test(html) || !/<\/html\s*>/i.test(html)) {
    throw erro(400, 'HTML_INVALIDO', 'informe um documento HTML completo em UTF-8');
  }
  return { dados, sha256: hash(dados) };
}

function validarMeses(meses) {
  const falha = () => erro(400, 'ESTADO_INVALIDO', 'dados do relatório inválidos');
  if (!meses || typeof meses !== 'object' || Array.isArray(meses)) throw falha();
  const vistos = new WeakSet(); let total = 0;
  function conferir(v, nivel) {
    if (++total > 100000 || nivel > 24) throw falha();
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'string') {
      if (v.includes('\0') || Buffer.from(v, 'utf8').toString('utf8') !== v) throw falha();
      return;
    }
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (!v || typeof v !== 'object' || vistos.has(v)) throw falha();
    vistos.add(v);
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw falha();
    for (const k of Object.keys(v)) {
      if (['__proto__', 'prototype', 'constructor'].includes(k) || k.includes('\0') || Buffer.from(k, 'utf8').toString('utf8') !== k) throw falha();
      conferir(v[k], nivel + 1);
    }
  }
  conferir(meses, 0);
  const serializado = JSON.stringify(meses);
  if (Buffer.byteLength(serializado, 'utf8') > MAX_BYTES) throw erro(413, 'ESTADO_GRANDE', 'o relatório deve ter até 2 MiB de dados');
  return serializado;
}
function validarRevisao(revisao) {
  if (!Number.isSafeInteger(revisao) || revisao < 1 || revisao >= 2147483647) throw erro(400, 'REVISAO_INVALIDA', 'revisão inválida');
  return revisao;
}
function validarAutor(autor) {
  if (typeof autor !== 'string' || !autor.trim() || autor.length > 160 || /[\u0000-\u001f\u007f]/.test(autor)) throw erro(400, 'AUTOR_INVALIDO', 'identifique o responsável pela operação');
  return autor.trim();
}
const metadados = r => ({ sha256: r.sha256, revisao: r.revisao, atualizadoEm: r.atualizado_em });
async function transacao(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['gestao:' + CHAVE]);
    const r = await fn(c);
    await c.query('COMMIT'); return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}
async function registrar(c, r, autor, origem) {
  await c.query(`INSERT INTO gestao_relatorio_estados (chave, revisao, html_sha256, meses, origem, criado_por)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6)`, [CHAVE, r.revisao, r.sha256, r.meses === null ? null : JSON.stringify(r.meses), origem, autor]);
}

async function importar(pool, { dados, autor, substituir = false }) {
  const v = validarHTML(dados); autor = validarAutor(autor);
  await init(pool);
  return transacao(pool, async c => {
    const atual = (await c.query('SELECT * FROM gestao_relatorios WHERE chave = $1 FOR UPDATE', [CHAVE])).rows[0];
    if (atual && atual.sha256 === v.sha256) return { ...metadados(atual), alterado: false };
    if (atual && !substituir) throw erro(409, 'ORIGINAL_DIVERGENTE', 'já existe outro HTML; use --substituir somente para autorizar uma nova versão, preservando o histórico');
    if (atual) validarRevisao(atual.revisao);
    const r = (await c.query(`INSERT INTO gestao_relatorios (chave, html, sha256, meses, revisao, atualizado_por)
      VALUES ($1, $2, $3, NULL, 1, $4)
      ON CONFLICT (chave) DO UPDATE SET html = EXCLUDED.html, sha256 = EXCLUDED.sha256, meses = NULL,
        revisao = gestao_relatorios.revisao + 1, atualizado_por = EXCLUDED.atualizado_por, atualizado_em = clock_timestamp()
      RETURNING *`, [CHAVE, v.dados, v.sha256, autor])).rows[0];
    await c.query(`INSERT INTO gestao_relatorio_originais (chave, sha256, html, criado_por)
      VALUES ($1, $2, $3, $4) ON CONFLICT (chave, sha256) DO NOTHING`, [CHAVE, v.sha256, v.dados, autor]);
    await registrar(c, r, autor, 'importacao');
    return { ...metadados(r), alterado: true };
  });
}
async function obter(pool) {
  const r = (await pool.query('SELECT html, sha256, meses, revisao, atualizado_em FROM gestao_relatorios WHERE chave = $1', [CHAVE])).rows[0];
  if (!r) throw erro(404, 'RELATORIO_NAO_IMPORTADO', 'relatório de produtividade ainda não importado');
  if (!Buffer.isBuffer(r.html) || hash(r.html) !== r.sha256) throw new Error('integridade do relatório inválida');
  return { html: r.html.toString('utf8'), meses: r.meses, ...metadados(r) };
}
async function salvar(pool, { meses, revisao }, autor) {
  const serializado = validarMeses(meses); validarRevisao(revisao); autor = validarAutor(autor);
  return transacao(pool, async c => {
    const atual = (await c.query('SELECT * FROM gestao_relatorios WHERE chave = $1 FOR UPDATE', [CHAVE])).rows[0];
    if (!atual) throw erro(404, 'RELATORIO_NAO_IMPORTADO', 'relatório de produtividade ainda não importado');
    if (atual.revisao !== revisao) throw erro(409, 'REVISAO_DESATUALIZADA', 'o relatório foi alterado em outra aba ou sessão — reabra a versão atual antes de salvar');
    const r = (await c.query(`UPDATE gestao_relatorios SET meses = $2::jsonb, revisao = revisao + 1,
      atualizado_por = $3, atualizado_em = clock_timestamp() WHERE chave = $1 RETURNING *`, [CHAVE, serializado, autor])).rows[0];
    await registrar(c, r, autor, 'edicao');
    return metadados(r);
  });
}
module.exports = { CHAVE, MAX_BYTES, init, erro, validarHTML, validarMeses, validarRevisao, importar, obter, salvar };
