'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const f = require('./protocolo-fonte');
const { pool } = require('./db');
const admin = u => ['Tabelião', 'Substituta do Tabelião'].includes(u?.cargo) ||
  String(process.env.HUB_ADMINS || '').split(',').map(s => s.trim()).includes(u?.login);
function acesso(row, usuario, editar = false) {
  if (!usuario?.login) throw f.falha(401, 'SESSAO_NECESSARIA', 'Entre no Hub para consultar a fonte.');
  const equipeCuradora = row.dados?.ato !== 'TEST' && ['Escrevente', 'Chefe do Setor de Protocolo'].includes(usuario.cargo);
  if ((editar || row.dados?.ato === 'TEST') && row.usuario !== usuario.login && !admin(usuario) && !(editar && equipeCuradora))
    throw f.falha(403, 'FONTE_RESTRITA', 'Este protocolo exige acesso do responsável ou do Tabelião.');
}
async function init() { await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', '20261006-protocolo-fonte.sql'), 'utf8')); }
async function obter(numero, usuario, client = pool, lock = false) {
  const r = await client.query('SELECT numero, dados, card_id, usuario, criado_em FROM protocolos WHERE numero = $1' + (lock ? ' FOR UPDATE' : ''), [f.numero(numero)]);
  const row = r.rows[0];
  if (!row) throw f.falha(404, 'PROTOCOLO_NAO_ENCONTRADO', 'Protocolo não encontrado.');
  acesso(row, usuario);
  return f.criarFonte(row);
}
async function doPedido(corpo, usuario) {
  if (corpo.protocolo == null || corpo.protocolo === '') {
    if (corpo.protocolo_ausente !== true) throw f.falha(400, 'FONTE_NAO_INFORMADA', 'Informe e confira o protocolo ou declare que este pedido ainda não tem protocolo.');
    return null;
  }
  const fonte = await obter(corpo.protocolo, usuario);
  f.validarRevisao(fonte, corpo.protocolo_revisao);
  f.validarAto(fonte, corpo.ato_minuta);
  return fonte;
}
async function conferir(fonte, usuario, client = pool, lock = false) {
  if (!fonte) return;
  const atual = await obter(fonte.protocolo.numero, usuario, client, lock);
  f.validarRevisao(atual, fonte.revisao.sha256);
}
async function situacao(fonte, usuario) {
  if (!fonte) return { fonte_desatualizada: null, fonte_verificacao: 'sem_snapshot' };
  try {
    const atual = await obter(fonte.protocolo.numero, usuario);
    return { fonte_desatualizada: atual.revisao.sha256 !== fonte.revisao.sha256, fonte_verificacao: 'comparada_com_protocolo_atual' };
  } catch (_) { return { fonte_desatualizada: null, fonte_verificacao: 'nao_foi_possivel_conferir_a_versao_atual' }; }
}
async function comFonteAtual(fonte, usuario, trabalho) {
  // Sem protocolo não há revisão a bloquear. Preserva o fluxo legado de gravação.
  if (!fonte) return trabalho(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await conferir(fonte, usuario, client, true);
    const resultado = await trabalho(client);
    await client.query('COMMIT');
    return resultado;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
async function salvarCuradoria(n, body, usuario) {
  const client = await pool.connect();
  let fonte;
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT numero, dados, card_id, usuario, criado_em FROM protocolos WHERE numero = $1 FOR UPDATE', [f.numero(n)]);
    const row = r.rows[0];
    if (!row) throw f.falha(404, 'PROTOCOLO_NAO_ENCONTRADO', 'Protocolo não encontrado.');
    acesso(row, usuario, true);
    const antes = f.criarFonte(row);
    f.validarRevisao(antes, body.expected_sha256);
    if (!body.curadoria || typeof body.curadoria !== 'object') throw f.falha(400, 'CURADORIA_INVALIDA', 'Informe a conferência dos dados.');
    const dados = { ...row.dados, curadoria: f.normalizarCuradoria(body.curadoria, usuario.login, new Date().toISOString()) };
    if (body.pagamentos !== undefined) dados.pagamentos = f.normalizarPagamentos(body.pagamentos);
    f.validarCuradoria(dados);
    fonte = f.criarFonte({ ...row, dados });
    // Preserva também a primeira versão legada; nada é apagado.
    for (const snapshot of [antes, fonte]) await client.query(
      'INSERT INTO protocolo_fonte_revisoes (numero, sha256, snapshot, autor) VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (numero,sha256) DO NOTHING',
      [row.numero, snapshot.revisao.sha256, JSON.stringify(snapshot), snapshot.revisao.autor]);
    await client.query('UPDATE protocolos SET dados = $2::jsonb WHERE numero = $1', [row.numero, JSON.stringify(dados)]);
    await client.query(`INSERT INTO protocolo_fonte_sync (numero,sha256,estado) VALUES ($1,$2,'pendente')
      ON CONFLICT (numero) DO UPDATE SET sha256=EXCLUDED.sha256,estado='pendente',atualizado_em=now()`, [row.numero, fonte.revisao.sha256]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  return fonte;
}
async function sincronizar(fonte) {
  if (!fonte.protocolo.card_id) return { estado: 'sem_cartao' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT numero, dados, card_id, usuario, criado_em FROM protocolos WHERE numero=$1 FOR UPDATE', [fonte.protocolo.numero]);
    if (!r.rows[0] || f.criarFonte(r.rows[0]).revisao.sha256 !== fonte.revisao.sha256) {
      await client.query('ROLLBACK');
      return { estado: 'versao_superada' };
    }
    const trello = require('./trello');
    const card = await trello.t('GET', '/cards/' + encodeURIComponent(fonte.protocolo.card_id) + '?fields=desc');
    const desc = f.atualizarDescricao(card.desc, fonte);
    await trello.t('PUT', '/cards/' + encodeURIComponent(fonte.protocolo.card_id), { desc });
    await client.query("UPDATE protocolo_fonte_sync SET estado='sincronizado',atualizado_em=now() WHERE numero=$1 AND sha256=$2", [fonte.protocolo.numero, fonte.revisao.sha256]);
    await client.query('COMMIT');
    return { estado: 'sincronizado' };
  } catch (_) {
    await client.query('ROLLBACK');
    // O protocolo já foi salvo. Não devolver erro que induza reenvio/duplicação.
    return { estado: 'pendente', aviso: 'Curadoria salva no Hub. A cópia do Trello ainda precisa ser sincronizada antes da geração externa.' };
  } finally { client.release(); }
}
async function registrarGeracao({ fonte, matriz, manifestos = [], texto, usuario, ferramenta }, client = pool) {
  const id = crypto.randomUUID();
  await client.query(`INSERT INTO protocolo_fonte_geracoes (id,usuario,ferramenta,protocolo,fonte_snapshot,conferencia,manifestos,texto_sha256)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8)`,
  [id, usuario.login, ferramenta, fonte?.protocolo.numero || null, JSON.stringify(fonte), JSON.stringify(matriz || []), JSON.stringify(manifestos), f.hash(String(texto || ''))]);
  return id;
}
async function obterGeracao(id, usuario) {
  if (!/^[a-f0-9-]{36}$/.test(String(id || ''))) throw f.falha(400, 'GERACAO_INVALIDA', 'Referência da geração inválida.');
  const r = await pool.query('SELECT * FROM protocolo_fonte_geracoes WHERE id=$1 AND usuario=$2', [id, usuario.login]);
  if (!r.rows[0]) throw f.falha(404, 'GERACAO_NAO_ENCONTRADA', 'Geração não encontrada para esta sessão.');
  return r.rows[0];
}
module.exports = { init, acesso, obter, doPedido, conferir, situacao, comFonteAtual, salvarCuradoria, sincronizar, registrarGeracao, obterGeracao };
