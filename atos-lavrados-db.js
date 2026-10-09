'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const MAX_BYTES = 20 * 1024 * 1024;
const CRITERIO = 'Extra Digital · Registrado(a) · data de lavratura';
const cache = new WeakMap();
const erro = (status, codigo, mensagem) => Object.assign(new Error(mensagem), { status, codigo });
const invalido = mensagem => erro(400, 'LOTE_INVALIDO', mensagem);
const hash = s => createHash('sha256').update(s).digest('hex');
function canonico(v) {
  if (Array.isArray(v)) return '[' + v.map(canonico).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonico(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function texto(v, max = 200) {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f\u007f]/.test(v) || Buffer.from(v).toString('utf8') !== v) throw invalido('texto obrigatório inválido');
  return v.trim();
}
function data(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v + 'T00:00:00Z')) || new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) throw invalido('data inválida; use AAAA-MM-DD');
  return v;
}
function mes(v) { if (typeof v !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) throw invalido('mês inválido'); return v; }
function corte(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/.test(v) || !Number.isFinite(Date.parse(v))) throw invalido('corte_em exige instante ISO com fuso');
  data(v.slice(0, 10));
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(v));
  const get = k => partes.find(p => p.type === k).value;
  return { instante: v, dia: `${get('year')}-${get('month')}-${get('day')}` };
}
const fimMes = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5), 0)).toISOString().slice(0, 10);
function revisao(v) { if (!Number.isSafeInteger(v) || v < 0 || v >= 2147483647) throw invalido('revisão-base inválida'); return v; }
function uuid(v) { if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)) throw invalido('identificador de operação inválido'); return v.toLowerCase(); }
function jsonSeguro(v) {
  const vistos = new WeakSet(); let n = 0;
  function visitar(x, p) {
    if (++n > 1000000 || p > 24) throw invalido('estrutura muito extensa');
    if (x === null || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))) return;
    if (typeof x === 'string') { if (x.includes('\0') || Buffer.from(x).toString('utf8') !== x) throw invalido('texto inválido'); return; }
    if (!x || typeof x !== 'object' || vistos.has(x)) throw invalido('dados JSON inválidos');
    vistos.add(x);
    if (!Array.isArray(x) && ![Object.prototype, null].includes(Object.getPrototypeOf(x))) throw invalido('objeto inválido');
    for (const k of Object.keys(x)) {
      if (['__proto__', 'constructor', 'prototype'].includes(k) || k.includes('\0')) throw invalido('campo não permitido');
      visitar(x[k], p + 1);
    }
  }
  visitar(v, 0);
  if (Buffer.byteLength(JSON.stringify(v)) > MAX_BYTES) throw erro(413, 'LOTE_GRANDE', 'lote maior que 20 MiB');
}
function validarLote(p) {
  jsonSeguro(p);
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw invalido('lote inválido');
  const id = uuid(p.operacao_id);
  if (!p.fonte || p.fonte.sistema !== 'Extra Digital') throw invalido('a fonte deve ser Extra Digital');
  const fonte = { sistema: 'Extra Digital', arquivo: texto(p.fonte.arquivo, 200), sha256: texto(p.fonte.sha256, 64) };
  if (!/^[0-9a-f]{64}$/i.test(fonte.sha256)) throw invalido('hash do arquivo inválido');
  if (!Array.isArray(p.meses) || !p.meses.length || p.meses.length > 60) throw invalido('declare entre 1 e 60 meses de cobertura');
  const mapa = new Map();
  const meses = p.meses.map(m => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw invalido('cobertura mensal inválida');
    const r = { mes: mes(m.mes), ate: data(m.ate), revisao_base: revisao(m.revisao_base), corte_em: corte(m.corte_em).instante, dia_final_completo: m.dia_final_completo };
    const diaCorte = corte(m.corte_em).dia;
    if (typeof r.dia_final_completo !== 'boolean' || (r.dia_final_completo ? diaCorte <= r.ate : diaCorte !== r.ate)) throw invalido('declare se o dia final está completo: corte no próprio dia é parcial; dia completo exige corte posterior (America/Sao_Paulo)');
    if (r.ate.slice(0, 7) !== r.mes || mapa.has(r.mes)) throw invalido('mês repetido ou cobertura incompatível');
    mapa.set(r.mes, r); return r;
  }).sort((a, b) => a.mes.localeCompare(b.mes));
  if (!Array.isArray(p.registros) || p.registros.length > 50000) throw invalido('envie até 50 mil atos');
  const chaves = new Set(), identidades = new Set();
  const registros = p.registros.map(r => {
    if (!r || r.status !== 4 || r.status_nome !== 'Registrado(a)') throw invalido('somente status 4 Registrado(a) pode integrar este lote');
    const semProtocolo = typeof r.protocolo === 'string' && !r.protocolo.trim();
    if (semProtocolo && (!Array.isArray(r.pendencia_identificacao) || !r.pendencia_identificacao.includes('protocolo_ausente_na_fonte') ||
      typeof r.originais?.Protocolo !== 'string' || r.originais.Protocolo.trim() !== '')) {
      throw invalido('protocolo vazio exige pendencia_identificacao e Protocolo vazio nos campos originais');
    }
    const campos = ['minuta', 'protocolo', 'livro', 'folha', 'documento'].map(k => k === 'protocolo' && semProtocolo ? '' : texto(r[k], 200));
    const chave = hash(JSON.stringify(campos));
    if (chaves.has(chave)) throw invalido('chave composta repetida; confira Minuta, Protocolo, Livro, Folha e Documento');
    chaves.add(chave);
    const identidade = JSON.stringify([campos[4], campos[0]]);
    if (identidades.has(identidade)) throw invalido('Documento e Minuta repetidos; uma correção de protocolo, livro ou folha não cria outro ato');
    identidades.add(identidade);
    const dia = data(r.data_lavratura), m = mapa.get(dia.slice(0, 7));
    if (!m || dia > m.ate) throw invalido('há ato fora dos meses ou do corte explicitamente cobertos');
    if (!r.originais || typeof r.originais !== 'object' || Array.isArray(r.originais) || !Object.keys(r.originais).length) throw invalido('preserve os campos originais de cada ato');
    // U.criador permanece somente nos originais: não é convertido em responsável.
    return { chave, mes: m.mes, data_lavratura: dia, registro: { ...r, ...Object.fromEntries(['minuta', 'protocolo', 'livro', 'folha', 'documento'].map((k, i) => [k, campos[i]])) } };
  }).sort((a, b) => a.chave.localeCompare(b.chave));
  const conteudo = JSON.parse(JSON.stringify(p));
  const { operacao_id, ...conteudoSemId } = conteudo;
  return { id, fonte, meses, registros, conteudo, sha256: hash(canonico(conteudoSemId)) };
}
async function init(pool) {
  if (!cache.has(pool)) cache.set(pool, (async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtext('cn2o-atos-lavrados-schema'))");
      await c.query(await fs.readFile(path.join(__dirname, 'migrations', '20261009-atos-lavrados.sql'), 'utf8'));
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  })().catch(e => { cache.delete(pool); throw e; }));
  return cache.get(pool);
}
async function transacao(pool, leitura, fn) {
  const c = await pool.connect();
  try {
    await c.query(leitura ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    if (!leitura) await c.query("SELECT pg_advisory_xact_lock(hashtext('cn2o-atos-lavrados-write'))");
    const r = await fn(c); await c.query('COMMIT'); return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
async function conferir(c, p) {
  const existente = (await c.query('SELECT sha256 FROM atos_lavrados_lotes WHERE id=$1', [p.id])).rows[0];
  if (existente) {
    if (existente.sha256 !== p.sha256) throw erro(409, 'OPERACAO_DIVERGENTE', 'operação já utilizada para outro conteúdo');
    return true;
  }
  const atuais = (await c.query('SELECT mes,revisao FROM atos_lavrados_meses WHERE mes=ANY($1::text[])', [p.meses.map(m => m.mes)])).rows;
  for (const m of p.meses) if ((atuais.find(a => a.mes === m.mes)?.revisao || 0) !== m.revisao_base) throw erro(409, 'REVISAO_DESATUALIZADA', 'um dos meses foi alterado; confira as versões atuais antes de importar');
  const conflito = (await c.query(`SELECT i.chave FROM atos_lavrados_itens i JOIN atos_lavrados_meses m USING(mes,revisao)
    WHERE (i.registro->>'documento',i.registro->>'minuta') IN
      (SELECT x->'registro'->>'documento',x->'registro'->>'minuta' FROM jsonb_array_elements($1::jsonb) x)
      AND NOT(i.mes=ANY($2::text[])) LIMIT 1`, [JSON.stringify(p.registros), p.meses.map(m => m.mes)])).rows.length;
  if (conflito) throw erro(409, 'ATO_EM_OUTRO_MES', 'há ato ativo em outro mês; inclua o mês anterior na conciliação para corrigir a data sem duplicar');
  return false;
}
const resultadoLote = (p, repetido) => ({ operacao_id: p.id, sha256: p.sha256, repetido, meses: p.meses.map(m => ({ mes: m.mes, ate: m.ate, corte_em: m.corte_em, dia_final_completo: m.dia_final_completo, revisao: m.revisao_base + 1, total: p.registros.filter(r => r.mes === m.mes).length })) });
async function importar(pool, entrada, autor, dryRun = false) {
  const p = validarLote(entrada); autor = texto(autor, 160);
  await init(pool);
  return transacao(pool, dryRun, async c => {
    const repetido = await conferir(c, p);
    const versoes_anteriores = (await c.query(`SELECT v.mes,v.revisao,v.ate::text,v.corte_em,v.dia_final_completo,v.total,v.sha256,v.lote_id
      FROM atos_lavrados_versoes v WHERE (v.mes,v.revisao) IN
      (SELECT x->>'mes',(x->>'revisao_base')::integer FROM jsonb_array_elements($1::jsonb) x) ORDER BY v.mes`, [JSON.stringify(p.meses)])).rows;
    if (dryRun || repetido) return { ...resultadoLote(p, repetido), dry_run: dryRun, confirmavel: true, versoes_anteriores };
    await c.query('INSERT INTO atos_lavrados_lotes(id,sha256,fonte,conteudo,criado_por) VALUES($1,$2,$3::jsonb,$4::jsonb,$5)', [p.id, p.sha256, JSON.stringify(p.fonte), JSON.stringify(p.conteudo), autor]);
    for (const m of p.meses) {
      const regs = p.registros.filter(r => r.mes === m.mes), rev = m.revisao_base + 1;
      const snapshot = { mes: m.mes, ate: m.ate, corte_em: m.corte_em, dia_final_completo: m.dia_final_completo, registros: regs };
      await c.query('INSERT INTO atos_lavrados_versoes(mes,revisao,ate,lote_id,sha256,total,corte_em,dia_final_completo) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [m.mes, rev, m.ate, p.id, hash(canonico(snapshot)), regs.length, m.corte_em, m.dia_final_completo]);
      await c.query(`INSERT INTO atos_lavrados_itens(mes,revisao,chave,data_lavratura,registro)
        SELECT $1,$2,x->>'chave',(x->>'data_lavratura')::date,x->'registro' FROM jsonb_array_elements($3::jsonb) x`, [m.mes, rev, JSON.stringify(regs)]);
      await c.query('INSERT INTO atos_lavrados_meses(mes,revisao) VALUES($1,$2) ON CONFLICT(mes) DO UPDATE SET revisao=EXCLUDED.revisao', [m.mes, rev]);
    }
    return { ...resultadoLote(p, false), dry_run: false, confirmavel: true, versoes_anteriores };
  });
}
async function listar(c) {
  const rows = (await c.query(`SELECT m.mes,m.revisao,v.ate::text,v.corte_em,v.dia_final_completo,v.sha256,l.criado_em AS importado_em,
    count(i.chave)::int AS total_observado,count(w.chave)::int AS com_vinculo,
    count(i.chave) FILTER (WHERE i.registro->>'protocolo'='')::int AS com_pendencia_identificacao
    FROM atos_lavrados_meses m JOIN atos_lavrados_versoes v USING(mes,revisao)
    JOIN atos_lavrados_lotes l ON l.id=v.lote_id LEFT JOIN atos_lavrados_itens i USING(mes,revisao)
    LEFT JOIN atos_lavrados_vinculos w ON w.chave=i.chave
    GROUP BY m.mes,m.revisao,v.ate,v.corte_em,v.dia_final_completo,v.sha256,l.criado_em ORDER BY m.mes`)).rows;
  return rows.map(r => ({ ...r, cobertura_completa: r.ate === fimMes(r.mes) && r.dia_final_completo, total_oficial: r.ate === fimMes(r.mes) && r.dia_final_completo ? r.total_observado : null, sem_vinculo: r.total_observado - r.com_vinculo }));
}
async function meses(pool) { await init(pool); return { criterio: CRITERIO, meses: await listar(pool) }; }
function periodo(inicio, fim) { data(inicio); data(fim); if (fim < inicio || Date.parse(fim) - Date.parse(inicio) > 3660 * 864e5) throw invalido('período inválido ou superior a dez anos'); return { inicio, fim }; }
async function resumo(pool, inicio, fim) {
  periodo(inicio, fim); await init(pool);
  return transacao(pool, true, async c => {
    const ms = (await listar(c)).filter(m => m.mes >= inicio.slice(0, 7) && m.mes <= fim.slice(0, 7));
    let completo = true, dia = inicio.slice(0, 7) + '-01';
    while (dia <= fim) {
      const m = ms.find(x => x.mes === dia.slice(0, 7));
      const atePeriodo = fim < fimMes(dia.slice(0, 7)) ? fim : fimMes(dia.slice(0, 7));
      if (!m || !m.corte_em || m.ate < atePeriodo || (m.ate === atePeriodo && !m.dia_final_completo)) completo = false;
      const d = new Date(dia + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); dia = d.toISOString().slice(0, 10);
    }
    const r = (await c.query(`SELECT count(*)::int AS total_observado,count(v.chave)::int AS com_vinculo,
      count(*) FILTER (WHERE i.registro->>'protocolo'='')::int AS com_pendencia_identificacao
      FROM atos_lavrados_itens i JOIN atos_lavrados_meses m USING(mes,revisao)
      LEFT JOIN atos_lavrados_vinculos v ON v.chave=i.chave WHERE i.data_lavratura BETWEEN $1::date AND $2::date`, [inicio, fim])).rows[0];
    return { criterio: CRITERIO, inicio, fim, ...r, total_oficial: completo ? r.total_observado : null, sem_vinculo: r.total_observado - r.com_vinculo, cobertura_completa: completo, meses: ms };
  });
}
async function versoes(pool, m) {
  mes(m); await init(pool);
  return (await pool.query(`SELECT v.mes,v.revisao,v.ate::text,v.corte_em,v.dia_final_completo,v.total,v.sha256,v.lote_id,l.criado_por,l.criado_em
    FROM atos_lavrados_versoes v JOIN atos_lavrados_lotes l ON l.id=v.lote_id WHERE v.mes=$1 ORDER BY v.revisao DESC`, [m])).rows;
}
async function atos(pool, inicio, fim, pagina = 1) {
  periodo(inicio, fim);
  if (!Number.isInteger(pagina) || pagina < 1 || pagina > 10000) throw invalido('página inválida');
  await init(pool);
  const itens = (await pool.query(`SELECT i.chave,i.data_lavratura::text,i.registro,v.protocolo_hub,
    COALESCE(v.revisao,0) AS vinculo_revisao,v.evidencia
    FROM atos_lavrados_itens i JOIN atos_lavrados_meses m USING(mes,revisao)
    LEFT JOIN atos_lavrados_vinculos v ON v.chave=i.chave
    WHERE i.data_lavratura BETWEEN $1::date AND $2::date ORDER BY i.data_lavratura,i.chave LIMIT 100 OFFSET $3`, [inicio, fim, (pagina - 1) * 100])).rows;
  return { inicio, fim, pagina, limite: 100, itens };
}
async function backup(pool, id) {
  uuid(id); await init(pool);
  const r = (await pool.query('SELECT * FROM atos_lavrados_lotes WHERE id=$1', [id])).rows[0];
  if (!r) throw erro(404, 'NAO_ENCONTRADO', 'lote não encontrado'); return r;
}
async function vincular(pool, p, autor) {
  jsonSeguro(p); autor = texto(autor, 160);
  if (!p || !/^[a-f0-9]{64}$/.test(p.chave || '') || !Number.isSafeInteger(p.protocolo_hub) || p.protocolo_hub <= 0) throw invalido('ato ou protocolo inválido');
  revisao(p.revisao_base);
  const evidencia = { tipo: texto(p.evidencia?.tipo, 80), referencia: texto(p.evidencia?.referencia, 2000) };
  await init(pool);
  return transacao(pool, false, async c => {
    const ato = (await c.query('SELECT 1 FROM atos_lavrados_itens i JOIN atos_lavrados_meses m USING(mes,revisao) WHERE i.chave=$1', [p.chave])).rows[0];
    const prot = (await c.query('SELECT numero FROM protocolos WHERE numero=$1', [p.protocolo_hub])).rows[0];
    if (!ato || !prot) throw erro(404, 'NAO_ENCONTRADO', 'ato ativo ou protocolo não encontrado');
    const atual = (await c.query('SELECT revisao FROM atos_lavrados_vinculos WHERE chave=$1', [p.chave])).rows[0];
    if ((atual?.revisao || 0) !== p.revisao_base) throw erro(409, 'REVISAO_DESATUALIZADA', 'o vínculo foi alterado; confira antes de salvar');
    const rev = p.revisao_base + 1;
    await c.query(`INSERT INTO atos_lavrados_vinculos(chave,revisao,protocolo_hub,evidencia,criado_por) VALUES($1,$2,$3,$4::jsonb,$5)
      ON CONFLICT(chave) DO UPDATE SET revisao=EXCLUDED.revisao,protocolo_hub=EXCLUDED.protocolo_hub,evidencia=EXCLUDED.evidencia,criado_por=EXCLUDED.criado_por,criado_em=clock_timestamp()`, [p.chave, rev, p.protocolo_hub, JSON.stringify(evidencia), autor]);
    await c.query('INSERT INTO atos_lavrados_vinculo_historico(chave,revisao,protocolo_hub,evidencia,criado_por) VALUES($1,$2,$3,$4::jsonb,$5)', [p.chave, rev, p.protocolo_hub, JSON.stringify(evidencia), autor]);
    return { chave: p.chave, revisao: rev, protocolo_hub: p.protocolo_hub };
  });
}
module.exports = { MAX_BYTES, CRITERIO, erro, init, validarLote, periodo, importar, meses, resumo, atos, versoes, backup, vincular };
