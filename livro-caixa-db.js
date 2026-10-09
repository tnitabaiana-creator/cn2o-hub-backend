'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const receita = require('./receita-liquida');
const MAX_BYTES = 10 * 1024 * 1024;
const CRITERIO = 'Livro-caixa do Tabelião: receita líquida após repasses, menos despesas confirmadas do próprio livro-caixa; IR projetado de 27,5% somente sobre saldo positivo. Projeção gerencial, não apuração fiscal definitiva.';
const percentual_ir = 27.5;
const inicializacoes = new WeakMap();
const erro = (status, codigo, mensagem) => Object.assign(new Error(mensagem), { status, codigo });
const hash = d => createHash('sha256').update(d).digest('hex');
function validarMes(mes) {
  if (typeof mes !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(mes)) throw erro(400, 'MES_INVALIDO', 'informe uma competência no formato AAAA-MM');
  return mes;
}
function init(pool) {
  if (!inicializacoes.has(pool)) inicializacoes.set(pool, (async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtext('cn2o-livro-caixa-v1'))");
      await c.query(await fs.readFile(path.join(__dirname, 'migrations', '20261009-livro-caixa.sql'), 'utf8'));
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  })().catch(e => { inicializacoes.delete(pool); throw e; }));
  return inicializacoes.get(pool);
}
function validarAnexo(a) {
  const falha = () => erro(400, 'ANEXO_INVALIDO', 'informe um anexo PDF, XLS, XLSX ou CSV válido');
  if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => !['nome', 'tipo', 'base64'].includes(k))) throw falha();
  if (typeof a.nome !== 'string' || !a.nome.trim() || a.nome.length > 160 || /[\x00-\x1f\x7f<>:"/\\|?*]/.test(a.nome)) throw falha();
  const ext = path.extname(a.nome).toLowerCase(), tipos = { '.pdf': 'application/pdf', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv' };
  if (!tipos[ext] || a.tipo !== tipos[ext] || typeof a.base64 !== 'string') throw falha();
  if (a.base64.length > 4 * Math.ceil(MAX_BYTES / 3)) throw erro(413, 'ANEXO_GRANDE', 'o anexo deve ter até 10 MiB');
  if (a.base64.length % 4 || /[^A-Za-z0-9+/=]/.test(a.base64)) throw falha();
  const bytes = Buffer.from(a.base64, 'base64');
  if (!bytes.length || bytes.toString('base64') !== a.base64) throw falha();
  if (bytes.length > MAX_BYTES) throw erro(413, 'ANEXO_GRANDE', 'o anexo deve ter até 10 MiB');
  if (ext === '.pdf' && bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw falha();
  if (ext === '.xls' && bytes.subarray(0, 8).toString('hex') !== 'd0cf11e0a1b11ae1') throw falha();
  if (ext === '.xlsx' && bytes.subarray(0, 4).toString('hex') !== '504b0304') throw falha();
  if (ext === '.csv' && (bytes.includes(0) || /<\s*(?:html|script|iframe)\b/i.test(bytes.toString('utf8')))) throw falha();
  return { id: randomUUID(), nome: a.nome.trim(), tipo: tipos[ext], bytes, sha256: hash(bytes) };
}
function validar(mes, b) {
  validarMes(mes);
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => !['revisao_base', 'total_despesas_centavos', 'fonte', 'anexo'].includes(k))) throw erro(400, 'PEDIDO_INVALIDO', 'dados do livro-caixa inválidos');
  if (!Number.isSafeInteger(b.revisao_base) || b.revisao_base < 0 || b.revisao_base >= 2147483647) throw erro(400, 'REVISAO_INVALIDA', 'revisão inválida');
  if (!Number.isSafeInteger(b.total_despesas_centavos) || b.total_despesas_centavos < 0 || b.total_despesas_centavos > 100000000000) throw erro(400, 'DESPESAS_INVALIDAS', 'informe o total confirmado das despesas em centavos inteiros, inclusive zero quando conferido');
  if (typeof b.fonte !== 'string' || !b.fonte.trim() || b.fonte.length > 2000 || /[\x00-\x1f\x7f]/.test(b.fonte)) throw erro(400, 'FONTE_INVALIDA', 'identifique a fonte e a conferência do total no seu livro-caixa');
  return { mes, revisao_base: b.revisao_base, total_despesas_centavos: b.total_despesas_centavos, fonte: b.fonte.trim(),
    anexo: !Object.hasOwn(b, 'anexo') ? undefined : b.anexo === null ? null : validarAnexo(b.anexo) };
}
function receitaDoMes(row) {
  if (!row) return { status: 'ausente', bruto: null, repasses: null, receita_liquida: null, centavos: null, fonte: null, importado_em: null };
  return { status: 'disponivel', ...receita.financeiro(row.dados.total), fonte: row.fonte || null, importado_em: row.importado_em || null };
}
const anexoMeta = row => row?.anexo_id ? { id: row.anexo_id, nome: row.anexo_nome, tipo: row.anexo_tipo, tamanho: Number(row.anexo_tamanho), sha256: row.anexo_sha256 } : null;
function despesasDoMes(row) {
  if (!row) return { revisao: 0, total: null, total_centavos: null, fonte: null, atualizado_por: null, atualizado_em: null, anexo: null };
  const cents = Number(row.total_despesas_centavos);
  return { revisao: row.revisao, total: cents / 100, total_centavos: cents, fonte: row.fonte, atualizado_por: row.atualizado_por, atualizado_em: row.atualizado_em, anexo: anexoMeta(row), sha256: row.sha256 };
}
function projetar(rec, desp) {
  if (rec.status !== 'disponivel' || desp.total_centavos == null) return { saldo: null, ir_projetado: null, liquido_projetado: null, centavos: null };
  const saldo = rec.centavos.receita_liquida - desp.total_centavos;
  const ir = receita.proporcao(Math.max(saldo, 0), 275n, 1000n), liquido = saldo - ir;
  return { saldo: saldo / 100, ir_projetado: ir / 100, liquido_projetado: liquido / 100, centavos: { saldo, ir_projetado: ir, liquido_projetado: liquido } };
}
const SELECT_VERSAO = `SELECT v.*,a.nome AS anexo_nome,a.tipo AS anexo_tipo,octet_length(a.bytes) AS anexo_tamanho,a.sha256 AS anexo_sha256
 FROM livro_caixa_versoes v LEFT JOIN livro_caixa_anexos a ON a.id=v.anexo_id`;
async function listar(pool) {
  await init(pool);
  const [financeiros, despesas] = await Promise.all([
    pool.query('SELECT ano,mes,dados,fonte,importado_em FROM produtividade_mes ORDER BY ano,mes'),
    pool.query(`${SELECT_VERSAO} JOIN livro_caixa_meses m ON m.mes=v.mes AND m.revisao=v.revisao ORDER BY v.mes`)
  ]);
  const fontes = new Map(financeiros.rows.map(r => [`${r.ano}-${String(r.mes).padStart(2, '0')}`, r]));
  const gastos = new Map(despesas.rows.map(r => [r.mes, r]));
  const meses = [...new Set([...fontes.keys(), ...gastos.keys()])].sort().map(mes => {
    const rec = receitaDoMes(fontes.get(mes)), desp = despesasDoMes(gastos.get(mes));
    return { mes, receita: rec, despesas: desp, projecao: projetar(rec, desp) };
  });
  return { criterio: CRITERIO, percentual_ir, meses };
}
async function salvar(pool, mes, body, autor) {
  const p = validar(mes, body);
  if (autor !== 'cesar.bravo') throw erro(403, 'ACESSO_RESTRITO', 'acesso restrito a César Bravo');
  await init(pool);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['livro-caixa:' + mes]);
    const anterior = (await c.query('SELECT v.* FROM livro_caixa_versoes v JOIN livro_caixa_meses m USING(mes,revisao) WHERE m.mes=$1', [mes])).rows[0];
    if ((anterior?.revisao || 0) !== p.revisao_base) throw erro(409, 'REVISAO_DESATUALIZADA', 'o mês foi alterado em outra sessão; reabra a versão atual antes de salvar');
    const fonte = (await c.query('SELECT dados,fonte,importado_em FROM produtividade_mes WHERE ano=$1 AND mes=$2', [Number(mes.slice(0, 4)), Number(mes.slice(5))])).rows[0];
    const rec = receitaDoMes(fonte), revisao = p.revisao_base + 1;
    let anexoId = anterior?.anexo_id || null, anexoHash = null;
    if (p.anexo === null) anexoId = null;
    else if (p.anexo) {
      const a = p.anexo; anexoId = a.id; anexoHash = a.sha256;
      await c.query('INSERT INTO livro_caixa_anexos(id,nome,tipo,bytes,sha256,criado_por) VALUES($1,$2,$3,$4,$5,$6)', [a.id, a.nome, a.tipo, a.bytes, a.sha256, autor]);
    }
    if (anexoId && !anexoHash) anexoHash = (await c.query('SELECT sha256 FROM livro_caixa_anexos WHERE id=$1', [anexoId])).rows[0].sha256;
    const sha256 = hash(JSON.stringify({ mes, revisao, total_despesas_centavos: p.total_despesas_centavos, fonte: p.fonte, anexo_sha256: anexoHash, receita_referencia: rec }));
    await c.query(`INSERT INTO livro_caixa_versoes(mes,revisao,total_despesas_centavos,fonte,anexo_id,receita_referencia,sha256,atualizado_por)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [mes, revisao, p.total_despesas_centavos, p.fonte, anexoId, JSON.stringify(rec), sha256, autor]);
    await c.query('INSERT INTO livro_caixa_meses(mes,revisao) VALUES($1,$2) ON CONFLICT(mes) DO UPDATE SET revisao=EXCLUDED.revisao', [mes, revisao]);
    const row = (await c.query(`${SELECT_VERSAO} WHERE v.mes=$1 AND v.revisao=$2`, [mes, revisao])).rows[0];
    await c.query('COMMIT');
    const desp = despesasDoMes(row);
    return { mes, receita: rec, despesas: desp, projecao: projetar(rec, desp) };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}
async function historico(pool, mes) {
  validarMes(mes); await init(pool);
  const rows = (await pool.query(`${SELECT_VERSAO} WHERE v.mes=$1 ORDER BY v.revisao DESC`, [mes])).rows;
  return { mes, versoes: rows.map(r => ({ despesas: despesasDoMes(r), receita_referencia: r.receita_referencia })) };
}
async function obterAnexo(pool, id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw erro(404, 'ANEXO_NAO_ENCONTRADO', 'anexo não encontrado');
  await init(pool);
  const a = (await pool.query('SELECT * FROM livro_caixa_anexos WHERE id=$1', [id])).rows[0];
  if (!a) throw erro(404, 'ANEXO_NAO_ENCONTRADO', 'anexo não encontrado');
  if (!Buffer.isBuffer(a.bytes) || hash(a.bytes) !== a.sha256) throw new Error('integridade do anexo inválida');
  return a;
}
module.exports = { MAX_BYTES, CRITERIO, init, erro, validarMes, validarAnexo, validar, receitaDoMes, despesasDoMes, projetar, listar, salvar, historico, obterAnexo };
