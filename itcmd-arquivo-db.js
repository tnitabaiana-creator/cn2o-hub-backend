'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const inicializacoes = new WeakMap();

function erro(status, codigo, mensagem) {
  return Object.assign(new Error(mensagem), { status, codigo });
}
function init(pool) {
  if (!inicializacoes.has(pool)) inicializacoes.set(pool, (async () => {
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query("SELECT pg_advisory_xact_lock(hashtext('cn2o-itcmd-arquivo-v1'))");
      await cliente.query(await fs.readFile(path.join(__dirname, 'migrations', '20261007-itcmd-arquivo.sql'), 'utf8'));
      await cliente.query('COMMIT');
    } catch (e) {
      await cliente.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { cliente.release(); }
  })().catch(e => { inicializacoes.delete(pool); throw e; }));
  return inicializacoes.get(pool);
}
const DOC_META = 'id, tipo, nome, mime, bytes, sha256, versao, criado_em';
async function documentos(cliente, trabalho, versao) {
  return (await cliente.query(`SELECT ${DOC_META} FROM itcmd_documentos
    WHERE trabalho_id = $1 AND versao = $2 ORDER BY criado_em, id`, [trabalho, versao])).rows;
}
function metadata(trabalho, versao) {
  return {
    id: trabalho.id, versao: versao.versao, titulo: versao.titulo, protocolo: versao.protocolo, modo: versao.estado.modo,
    criado_por: trabalho.criado_por, criado_em: trabalho.criado_em,
    atualizado_por: versao.criado_por, atualizado_em: versao.criado_em
  };
}
async function autorizado(cliente, id, usuario, admin) {
  const r = await cliente.query('SELECT * FROM itcmd_trabalhos WHERE id = $1 AND (criado_por = $2 OR $3::boolean)', [id, usuario.login, admin]);
  if (!r.rows.length) throw erro(404, 'NAO_ENCONTRADO', 'trabalho não encontrado');
  return r.rows[0];
}

async function salvar(pool, usuario, admin, pedido) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    // O mesmo pedido pode ser repetido após queda da rede. O lock por operação
    // também protege criações cujo UUID do trabalho foi atribuído pelo servidor.
    await cliente.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['itcmd-op', usuario.login, pedido.operacao_id])]);
    const repetida = await cliente.query('SELECT * FROM itcmd_trabalho_versoes WHERE criado_por = $1 AND operacao_id = $2', [usuario.login, pedido.operacao_id]);
    if (repetida.rows.length) {
      const v = repetida.rows[0];
      if (v.pedido_sha256 !== pedido.sha256) throw erro(409, 'OPERACAO_DIVERGENTE', 'esta operação já foi usada com outro conteúdo — atualize a página antes de tentar novamente');
      const t = await autorizado(cliente, v.trabalho_id, usuario, admin);
      const resposta = { ...metadata(t, v), documentos: await documentos(cliente, t.id, v.versao) };
      await cliente.query('COMMIT');
      return resposta;
    }
    const id = pedido.id || randomUUID();
    await cliente.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['itcmd-trabalho', id])]);
    const existente = (await cliente.query('SELECT * FROM itcmd_trabalhos WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (existente && existente.criado_por !== usuario.login && !admin) throw erro(404, 'NAO_ENCONTRADO', 'trabalho não encontrado');
    if ((!existente && pedido.versao_base !== 0) || (existente && existente.versao !== pedido.versao_base)) {
      throw erro(409, 'VERSAO_DESATUALIZADA', 'este trabalho foi alterado em outra aba ou sessão — reabra a versão atual antes de salvar');
    }
    const versao = pedido.versao_base + 1;
    let trabalho;
    if (!existente) {
      trabalho = (await cliente.query(`INSERT INTO itcmd_trabalhos
        (id, criado_por, titulo, protocolo, versao, atualizado_por) VALUES ($1, $2, $3, $4, $5, $2) RETURNING *`,
      [id, usuario.login, pedido.titulo, pedido.protocolo, versao])).rows[0];
    } else {
      trabalho = (await cliente.query(`UPDATE itcmd_trabalhos SET titulo = $2, protocolo = $3, versao = $4,
        atualizado_por = $5, atualizado_em = clock_timestamp() WHERE id = $1 RETURNING *`,
      [id, pedido.titulo, pedido.protocolo, versao, usuario.login])).rows[0];
    }
    const snapshot = (await cliente.query(`INSERT INTO itcmd_trabalho_versoes
      (trabalho_id, versao, titulo, protocolo, estado, criado_por, operacao_id, pedido_sha256)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) RETURNING *`,
    [id, versao, pedido.titulo, pedido.protocolo, JSON.stringify(pedido.estado), usuario.login, pedido.operacao_id, pedido.sha256])).rows[0];
    for (const d of pedido.documentos) {
      await cliente.query(`INSERT INTO itcmd_documentos (id, trabalho_id, versao, tipo, nome, mime, dados, bytes, sha256)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [randomUUID(), id, versao, d.tipo, d.nome, d.mime, d.dados, d.dados.length, d.sha256]);
    }
    const resposta = { ...metadata(trabalho, snapshot), documentos: await documentos(cliente, id, versao) };
    await cliente.query('COMMIT');
    return resposta;
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { cliente.release(); }
}

async function listar(pool, usuario, admin, { busca = '', pagina = 1, grupo } = {}) {
  const filtro = '%' + busca.replace(/[\\%_]/g, '\\$&') + '%';
  const args = [usuario.login, admin, filtro, grupo || null];
  const from = `FROM itcmd_trabalhos t JOIN itcmd_trabalho_versoes v ON v.trabalho_id = t.id AND v.versao = t.versao`;
  const where = `WHERE (t.criado_por = $1 OR $2::boolean) AND (t.titulo ILIKE $3 ESCAPE '\\' OR t.protocolo ILIKE $3 ESCAPE '\\')
    AND ($4::text IS NULL OR ($4 = 'inventario' AND v.estado->>'modo' IN ('inventario', 'cumulativo')) OR ($4 = 'doacao' AND v.estado->>'modo' = 'doacao'))`;
  const total = Number((await pool.query(`SELECT count(*) AS total ${from} ${where}`, args)).rows[0].total);
  // Uma única leitura entrega os metadados e os anexos daquela versão. Nunca há
  // BYTEA na listagem nem mistura de versões durante um salvamento concorrente.
  const r = await pool.query(`SELECT t.id, t.titulo, t.protocolo, t.versao, t.criado_por, t.criado_em,
    t.atualizado_por, t.atualizado_em, v.estado->>'modo' AS modo,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'tipo', d.tipo, 'nome', d.nome, 'mime', d.mime,
      'bytes', d.bytes, 'sha256', d.sha256, 'versao', d.versao, 'criado_em', d.criado_em) ORDER BY d.criado_em, d.id)
      FROM itcmd_documentos d WHERE d.trabalho_id = t.id AND d.versao = t.versao), '[]'::jsonb) AS documentos
    ${from} ${where} ORDER BY t.atualizado_em DESC, t.id LIMIT 25 OFFSET $5`, [...args, (pagina - 1) * 25]);
  return { itens: r.rows, total, pagina };
}

async function obter(pool, usuario, admin, id, versao) {
  const cliente = await pool.connect();
  try {
    // Estado, histórico e anexos pertencem à mesma visão, mesmo enquanto outra aba salva.
    await cliente.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const t = await autorizado(cliente, id, usuario, admin);
    const numero = versao || t.versao;
    const v = (await cliente.query('SELECT * FROM itcmd_trabalho_versoes WHERE trabalho_id = $1 AND versao = $2', [id, numero])).rows[0];
    if (!v) throw erro(404, 'NAO_ENCONTRADO', 'versão não encontrada');
    const resposta = { ...metadata(t, v), estado: v.estado, documentos: await documentos(cliente, id, numero) };
    if (!versao) {
      const lista = (await cliente.query(`SELECT versao, criado_em, criado_por, titulo, protocolo FROM itcmd_trabalho_versoes
        WHERE trabalho_id = $1 ORDER BY versao DESC`, [id])).rows;
      const docs = (await cliente.query(`SELECT ${DOC_META} FROM itcmd_documentos WHERE trabalho_id = $1 ORDER BY criado_em, id`, [id])).rows;
      resposta.versoes = lista.map(item => ({ ...item, documentos: docs.filter(d => d.versao === item.versao) }));
    }
    await cliente.query('COMMIT');
    return resposta;
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { cliente.release(); }
}
async function documento(pool, usuario, admin, id) {
  const r = await pool.query(`SELECT d.nome, d.mime, d.dados, d.bytes, d.sha256 FROM itcmd_documentos d
    JOIN itcmd_trabalhos t ON t.id = d.trabalho_id WHERE d.id = $1 AND (t.criado_por = $2 OR $3::boolean)`, [id, usuario.login, admin]);
  if (!r.rows.length) throw erro(404, 'NAO_ENCONTRADO', 'documento não encontrado');
  return r.rows[0];
}
module.exports = { init, salvar, listar, obter, documento, erro };
