// atendimentos.js — atendimentos do balcão (senhas do NextQS) no Hub, sem n8n (v1.39).
//
// Substitui os workflows "CN2O · NextQS → Painel de Atendimentos" e "… → Relatório
// mensal (PDF)" do n8n, com a mesma regra de cálculo:
//   • coleta: seg–sex às 17h (agendador.js), hoje e os 3 dias anteriores — na segunda
//     cobre a sexta, e a senha finalizada depois da coleta de um dia é corrigida na seguinte;
//   • um registro por dia (atendimentos_dia): linhas agrupadas por fila · atendente ·
//     guichê · unidade, no formato compacto do painel —
//       r = [fila, atendente, guichê, unidade, emitidas, atendidas, não atendidas,
//            Σ espera (s), nº esperas, Σ atendimento (s), nº atendimentos, Σ csat, nº csat]
//       h = [[hora, senhas emitidas], …]
//   • situação da coleta em atendimentos_status (chave 'ultima', 'ultima_falha',
//     'relatorio_AAAA-MM' = relatório mensal enviado);
//   • relatório mensal: PDF de 2 folhas (atendimentos-pdf.js) no 1º dia útil às 7h, por
//     e-mail aos mesmos destinatários dos relatórios das escreventes, e para baixar na aba.
//
// Rotas (montadas em relatorios.js, depois de exigeAdmin — só o Tabelião):
//   GET  /hub/relatorios/atendimentos?desde=AAAA-MM-DD   → dias + situação (padrão: 400 dias)
//   POST /hub/relatorios/atendimentos/atualizar { inicio?, fim? } → coleta agora (≤ 92 dias)
//   POST /hub/relatorios/atendimentos/carga { desde }     → histórico, em segundo plano
//   GET  /hub/relatorios/atendimentos/pdf?mes=AAAA-MM      → o PDF do mês
//   POST /hub/relatorios/atendimentos/enviar { mes }       → envia o PDF do mês por e-mail
'use strict';

const express = require('express');
const db = require('./db');
const cal = require('./horas-uteis');
const nextqs = require('./nextqs');
const pdf = require('./atendimentos-pdf');

const q = (texto, params) => db.pool.query(texto, params);
const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
const RE_MES = /^\d{4}-\d{2}$/;
const OFF = -3 * 3600e3;                        // America/Maceio (UTC-3, sem horário de verão)
const locIso = t => new Date(t + OFF).toISOString();
const hojeLocal = (agora = Date.now()) => locIso(agora).slice(0, 10);

// ---------------------------------------------------------------- cálculo (puro)
// Senhas do NextQS → um item por dia de inicio a fim (dias sem senha entram com zero).
function agregarPorDia(senhas, inicio, fim, agora = Date.now()) {
  const hoje = hojeLocal(agora);
  const dias = {};
  const garante = d => dias[d] || (dias[d] = { g: {}, h: {}, n: 0 });
  for (let d = inicio; d <= fim; d = cal.somaDias(d, 1)) garante(d);
  const seg = (a, b) => {
    const ta = Date.parse(a), tb = Date.parse(b);
    if (!isFinite(ta) || !isFinite(tb)) return null;
    const s = (tb - ta) / 1000;
    return s >= 0 && s < 43200 ? s : null;        // mais de 12 h é registro esquecido aberto
  };
  const rot = v => (Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v))).trim();
  for (const t of senhas) {
    if (!t || typeof t !== 'object' || (!t.ticket_generated_at && !t.created_at)) continue;
    if (t.is_deleted_at) continue;
    const ts = Date.parse(t.ticket_generated_at || t.created_at);
    if (!isFinite(ts)) continue;
    const L = locIso(ts), d = L.slice(0, 10), h = L.slice(11, 13) + 'h';
    if (d < inicio || d > fim) continue;
    const D = garante(d); D.n++;
    const fila = rot(t.queue_label) || '(sem fila)';
    const atend = rot(t.user_label);
    const guiche = (rot(t.service_desk_label) + (t.service_desk_number ? ' ' + t.service_desk_number : '')).trim();
    const unid = rot(t.site_label);
    const k = [fila, atend, guiche, unid].join('|');
    const r = D.g[k] || (D.g[k] = [fila, atend, guiche, unid, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    r[4]++;
    const atendida = !!t.service_started_at && !t.is_noshow_at;
    const naoAtendida = !!t.is_noshow_at || (!t.service_started_at && d < hoje);
    if (atendida) r[5]++;
    if (naoAtendida) r[6]++;
    const espera = seg(t.ticket_generated_at, t.ticket_first_call_at || t.service_started_at);
    if (espera != null) { r[7] += espera; r[8]++; }
    const duracao = seg(t.service_started_at, t.service_ended_at);
    if (duracao != null && atendida) { r[9] += duracao; r[10]++; }
    if (t.csat) { r[11] += Number(t.csat) || 0; r[12]++; }
    D.h[h] = (D.h[h] || 0) + 1;
  }
  return Object.keys(dias).sort().map(d => ({
    dia: d,
    senhas: dias[d].n,
    dados: {
      v: 1,
      r: Object.values(dias[d].g).map(r => r.map(x => (typeof x === 'number' ? Math.round(x) : x))),
      h: Object.entries(dias[d].h).sort()
    }
  }));
}

// [inicio, fim] em janelas de até nextqs.JANELA_DIAS dias, da mais recente para a mais antiga.
function janelas(inicio, fim, tam = nextqs.JANELA_DIAS) {
  const out = [];
  let f = fim;
  while (f >= inicio) {
    let i = cal.somaDias(f, -(tam - 1));
    if (i < inicio) i = inicio;
    out.push([i, f]);
    f = cal.somaDias(i, -1);
  }
  return out;
}

// ---------------------------------------------------------------- banco
async function init() {
  await q(`
    CREATE TABLE IF NOT EXISTS atendimentos_dia (
      dia           DATE PRIMARY KEY,
      senhas        INTEGER NOT NULL DEFAULT 0,
      dados         JSONB NOT NULL,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS atendimentos_status (
      chave     TEXT PRIMARY KEY,
      ok        BOOLEAN NOT NULL,
      mensagem  TEXT,
      periodo   TEXT,
      senhas    INTEGER,
      quando    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function gravarDias(dias) {
  for (const d of dias) {
    await q(`INSERT INTO atendimentos_dia (dia, senhas, dados, atualizado_em) VALUES ($1, $2, $3, now())
             ON CONFLICT (dia) DO UPDATE SET senhas = EXCLUDED.senhas, dados = EXCLUDED.dados, atualizado_em = now()`,
    [d.dia, d.senhas, JSON.stringify(d.dados)]);
  }
}
async function gravarStatus(chave, s) {
  await q(`INSERT INTO atendimentos_status (chave, ok, mensagem, periodo, senhas, quando) VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (chave) DO UPDATE SET ok = EXCLUDED.ok, mensagem = EXCLUDED.mensagem, periodo = EXCLUDED.periodo,
             senhas = EXCLUDED.senhas, quando = now()`,
  [chave, !!s.ok, s.mensagem || null, s.periodo || null, s.senhas == null ? null : s.senhas]);
}
async function statusTodos() {
  const r = await q('SELECT chave, ok, mensagem, periodo, senhas, quando FROM atendimentos_status');
  return Object.fromEntries(r.rows.map(x => [x.chave, x]));
}
const diaIso = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
async function lerDias(desde, ate = '9999-12-31') {
  const r = await q(`SELECT dia, dados, atualizado_em FROM atendimentos_dia WHERE dia >= $1 AND dia <= $2 ORDER BY dia`, [desde, ate]);
  return r.rows.map(x => ({ dia: diaIso(x.dia), dados: x.dados, atualizado_em: x.atualizado_em }));
}

// ---------------------------------------------------------------- coleta
// Busca [inicio, fim] no NextQS (em janelas) e grava. Padrão: hoje e os 3 dias anteriores.
async function coletar({ inicio, fim, agora = Date.now(), buscar = nextqs.senhas } = {}) {
  const hoje = hojeLocal(agora);
  if (!RE_DIA.test(fim || '') || fim > hoje) fim = hoje;
  if (!RE_DIA.test(inicio || '')) inicio = cal.somaDias(hoje, -3);
  if (inicio > fim) inicio = fim;
  const periodo = `${inicio} a ${fim}`;
  let senhas = 0, dias = 0;
  try {
    for (const [a, b] of janelas(inicio, fim)) {
      const lista = await buscar(a, b);
      const porDia = agregarPorDia(lista, a, b, agora);
      await gravarDias(porDia);
      senhas += porDia.reduce((s, d) => s + d.senhas, 0);
      dias += porDia.length;
    }
  } catch (e) {
    const falha = { ok: false, mensagem: String(e.message || e).slice(0, 500), periodo, senhas: 0 };
    await gravarStatus('ultima', falha);
    await gravarStatus('ultima_falha', falha);
    throw e;
  }
  const mensagem = `Coleta concluída: ${senhas} senha(s) em ${dias} dia(s).`;
  await gravarStatus('ultima', { ok: true, mensagem, periodo, senhas });
  return { inicio, fim, dias, senhas, mensagem };
}

// Carga do histórico, em segundo plano (uma por vez).
let estadoCarga = null;
function iniciarCarga(desde, por) {
  if (estadoCarga && estadoCarga.situacao === 'rodando') {
    throw Object.assign(new Error('já há uma carga rodando'), { status: 409 });
  }
  const fim = hojeLocal();
  estadoCarga = { situacao: 'rodando', desde, por, inicio: new Date().toISOString() };
  coletar({ inicio: desde, fim })
    .then(r => { estadoCarga = { ...estadoCarga, situacao: 'concluida', fim: new Date().toISOString(), resultado: r }; })
    .catch(e => { estadoCarga = { ...estadoCarga, situacao: 'erro', fim: new Date().toISOString(), erro: e.message }; });
  return estadoCarga;
}

// ---------------------------------------------------------------- relatório mensal
const mesAnterior = mes => new Date(Date.UTC(+mes.slice(0, 4), +mes.slice(5, 7) - 2, 1)).toISOString().slice(0, 7);
const fimDoMes = mes => new Date(Date.UTC(+mes.slice(0, 4), +mes.slice(5, 7), 0)).toISOString().slice(0, 10);

async function pdfDoMes(mes) {
  const linhas = await lerDias(mesAnterior(mes) + '-01', fimDoMes(mes));
  return pdf.montarPdf({ mes, linhas });
}

async function enviarMensal(mes, { manual = false } = {}) {
  const email = require('./relatorio-email');
  const g = await pdfDoMes(mes);
  const { para, homologacao } = email.destinatarios();
  const r = g.resumo, nome = pdf.nomeMes(mes);
  const assunto = `${homologacao ? '[HOMOLOGAÇÃO] ' : ''}Relatório mensal de atendimentos · ${nome}`;
  const linhas = [
    `${pdf.fmtN(r.senhas)} senhas emitidas e ${pdf.fmtN(r.atendidas)} atendidas em ${r.dias} dia(s) com atendimento.`,
    `Espera média: ${pdf.fmtT(r.espera_media)} · atendimento médio: ${pdf.fmtT(r.atendimento_medio)}.`,
    'O relatório completo, com a comparação com o mês anterior, está no PDF anexo.'
  ];
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:24px;background:#f1efeb;font:15px/1.6 Arial,Helvetica,sans-serif;color:#202a3a">
    <div style="max-width:620px;margin:0 auto;background:#fff;border-top:5px solid #631325;border-radius:8px;padding:22px 26px">
      <div style="font:700 12px Arial;letter-spacing:.14em;text-transform:uppercase;color:#631325">CN2O · Atendimentos do balcão</div>
      <h1 style="margin:6px 0 12px;font:700 24px Georgia,serif;color:#202a3a">Atendimentos de ${nome}</h1>
      ${linhas.map(l => `<p style="margin:0 0 8px">${l}</p>`).join('')}
      <p style="margin:16px 0 0;font-size:12px;color:#3a4454">Fonte: API do NextQS, coletada automaticamente pelo Hub CN2O.</p>
    </div></body></html>`;
  await email.enviar({
    para, assunto, html, texto: [assunto, '', ...linhas].join('\n'),
    anexos: [{ nome: g.nome, tipo: 'application/pdf', conteudo: g.pdf }]
  });
  await gravarStatus('relatorio_' + mes, { ok: true, mensagem: (manual ? 'enviado manualmente para ' : 'enviado para ') + para.join(', '), periodo: mes, senhas: r.senhas });
  return { mes, para, homologacao, resumo: r };
}

// Agendador: no 1º dia útil às 7h, o PDF do mês anterior (uma vez só — o banco é a trava).
async function enviarMensalSeDevido(dataRef) {
  const mes = mesAnterior(dataRef.slice(0, 7));
  const s = (await statusTodos())['relatorio_' + mes];
  if (s && s.ok) return { situacao: 'resolvido' };
  const r = await q('SELECT count(*)::int AS n FROM atendimentos_dia WHERE dia >= $1 AND dia <= $2 AND senhas > 0', [mes + '-01', fimDoMes(mes)]);
  if (!r.rows[0].n) return { situacao: 'sem-dados' };
  await enviarMensal(mes);
  return { situacao: 'enviado' };
}

// ---------------------------------------------------------------- rotas
const router = express.Router();
const json = express.json({ limit: '16kb' });
const auditar = (req, detalhe) => require('./hub').auditar(req, 'admin', 'relatorios', detalhe);
// v1.39.2: 500 com mensagem genérica (o detalhe vai ao log); 4xx de validação seguem claros
const falha = (res, e) => {
  if (!e.status) console.error('[atendimentos]', e.message);
  res.status(e.status || 500).json({ erro: e.status ? e.message : 'falha interna — tente de novo' });
};

router.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const desde = RE_DIA.test(String(req.query.desde || '')) ? String(req.query.desde) : cal.somaDias(hojeLocal(), -400);
    const [dias, status] = await Promise.all([lerDias(desde), statusTodos()]);
    res.json({ configurado: nextqs.configurado(), dias, status, carga: estadoCarga });
  } catch (e) { falha(res, e); }
});

router.post('/atualizar', json, async (req, res) => {
  if (!nextqs.configurado()) return res.status(503).json({ erro: 'a coleta do NextQS ainda não foi configurada no servidor' });
  const b = req.body || {};
  const hoje = hojeLocal();
  const fim = RE_DIA.test(b.fim || '') && b.fim <= hoje ? b.fim : hoje;
  const inicio = RE_DIA.test(b.inicio || '') ? b.inicio : cal.somaDias(fim, -3);
  if (inicio < cal.somaDias(fim, -92)) return res.status(400).json({ erro: 'para mais de 92 dias, use a carga do histórico' });
  try {
    const r = await coletar({ inicio, fim });
    auditar(req, `atendimentos: coleta ${inicio} a ${fim}`);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(502).json({ erro: e.message }); }
});

router.post('/carga', json, (req, res) => {
  if (!nextqs.configurado()) return res.status(503).json({ erro: 'a coleta do NextQS ainda não foi configurada no servidor' });
  const desde = String((req.body || {}).desde || '');
  if (!RE_DIA.test(desde) || desde > hojeLocal()) return res.status(400).json({ erro: 'desde deve ser AAAA-MM-DD, até hoje' });
  try {
    const st = iniciarCarga(desde, req.usuario && req.usuario.login);
    auditar(req, `atendimentos: carga desde ${desde}`);
    res.status(202).json(st);
  } catch (e) { falha(res, e); }
});

router.get('/pdf', async (req, res) => {
  const mes = String(req.query.mes || '');
  if (!RE_MES.test(mes)) return res.status(400).json({ erro: 'mes deve ser AAAA-MM' });
  try {
    const g = await pdfDoMes(mes);
    auditar(req, `atendimentos: PDF ${mes}`);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="atendimentos-cn2o-${mes}.pdf"; filename*=UTF-8''${encodeURIComponent(g.nome)}`);
    res.set('Cache-Control', 'no-store');
    res.send(g.pdf);
  } catch (e) { falha(res, e); }
});

router.post('/enviar', json, async (req, res) => {
  const mes = String((req.body || {}).mes || '');
  if (!RE_MES.test(mes)) return res.status(400).json({ erro: 'mes deve ser AAAA-MM' });
  if (!require('./relatorio-email').configurado()) return res.status(503).json({ erro: 'o e-mail dos relatórios não está configurado' });
  try {
    const r = await enviarMensal(mes, { manual: true });
    auditar(req, `atendimentos: PDF ${mes} por e-mail`);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(502).json({ erro: e.message }); }
});

module.exports = {
  router, init, agregarPorDia, janelas, coletar, enviarMensal, enviarMensalSeDevido, pdfDoMes,
  lerDias, hojeLocal, mesAnterior
};
