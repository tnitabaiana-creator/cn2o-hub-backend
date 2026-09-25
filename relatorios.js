// relatorios.js — relatórios semanal e mensal das escreventes (v1.38).
//
// Junta as peças: lê conclusoes/pendencias/pesos_ato do banco, calcula (reports.js),
// monta HTML + CSV (relatorio-email.js) e envia. O agendador (agendador.js) chama
// enviarSeDevido(); as rotas abaixo são de administração, para ver e testar.
//
// Montado no server.js com   app.use('/hub/relatorios', require('./relatorios').router)
// Acesso: a sessão do hub (X-Auth-Token) de um administrador. Os relatórios medem o
// trabalho de cada escrevente, então RELATORIOS_ADMINS (logins por vírgula) pode
// restringir a quem os vê; sem ela, valem os HUB_ADMINS (padrão: cesar.bravo). Prévia,
// envio e carga entram na trilha de auditoria do hub (ação 'admin', ferramenta 'relatorios').
//   GET  /hub/relatorios/status               → rastreio, webhooks e e-mail: o que está configurado
//   GET  /hub/relatorios/previa?tipo=semanal|mensal&ref=AAAA-MM-DD&formato=html|json|csv
//                                             → o relatório como seria enviado em "ref"
//                                               (sem ref: hoje), sem enviar nada
//   POST /hub/relatorios/enviar { tipo, ref } → envia agora (manual: não trava o automático)
//   GET  /hub/relatorios/envios               → últimos envios
//   POST /hub/relatorios/carga { desde }      → carga retroativa em segundo plano
'use strict';

const express = require('express');
const db = require('./db');
const cal = require('./horas-uteis');
const reports = require('./reports');
const email = require('./relatorio-email');
const trello = require('./trello');
const rastreio = require('./rastreio');

const q = (texto, params) => db.pool.query(texto, params);
const TIPOS = ['semanal', 'mensal'];
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

// ------------------------------------------------------------ períodos
function montar(inicioISO, fimISO) {
  return { inicioISO, fimISO, inicio: cal.meiaNoiteLocal(inicioISO), fim: cal.meiaNoiteLocal(cal.somaDias(fimISO, 1)) };
}
// Período coberto pelo relatório enviado no dia dataRef (AAAA-MM-DD local):
// semanal → a semana (seg–dom) anterior à de dataRef; mensal → o mês anterior.
function periodo(tipo, dataRef) {
  if (tipo === 'semanal') {
    const sem = new Date(dataRef + 'T12:00:00Z').getUTCDay();
    const segunda = cal.somaDias(dataRef, -((sem + 6) % 7));
    return montar(cal.somaDias(segunda, -7), cal.somaDias(segunda, -1));
  }
  if (tipo === 'mensal') {
    const ano = +dataRef.slice(0, 4), mes = +dataRef.slice(5, 7);
    const ini = mes === 1 ? `${ano - 1}-12-01` : `${ano}-${String(mes - 1).padStart(2, '0')}-01`;
    return montar(ini, cal.somaDias(`${dataRef.slice(0, 7)}-01`, -1));
  }
  throw new Error('tipo de relatório inválido: ' + tipo);
}
// o período imediatamente anterior (para a comparação)
const periodoAnterior = (tipo, per) => periodo(tipo, per.inicioISO);

// ------------------------------------------------------------ dados
// Cartões nas listas de trabalho de cada escrevente AGORA, e quantos com prazo vencido.
// Vem direto do Trello; se falhar, o relatório sai sem esse pedaço.
async function wipAtual(escreventes) {
  if (!process.env.TRELLO_KEY || !process.env.TRELLO_TOKEN) return null;
  const agora = Date.now(), out = {};
  const trabalho = new Set(['elaboracao', 'retrabalho', 'conferencia', 'pendencia', 'assinatura']);
  for (const e of escreventes) {
    try {
      const [listas, cartoes] = await Promise.all([
        trello.t('GET', `/boards/${e.board_id}/lists?fields=name&filter=open`),
        trello.t('GET', `/boards/${e.board_id}/cards?fields=idList,due,dueComplete&filter=open`)
      ]);
      const cat = new Map(listas.map(l => [l.id, rastreio.categoriaDaLista(l.name)]));
      const ativos = cartoes.filter(c => trabalho.has(cat.get(c.idList)));
      out[e.login] = {
        total: ativos.length,
        atrasados: ativos.filter(c => c.due && !c.dueComplete && new Date(c.due).getTime() < agora).length
      };
    } catch (err) {
      console.error(`[relatórios] WIP de ${e.login}:`, err.message);
    }
  }
  return out;
}

async function coletar(tipo, per, { wip = true } = {}) {
  const ant = periodoAnterior(tipo, per);
  const inicioJanela = new Date(per.fim.getTime() - 90 * 86400e3);
  const [esc, pesos, conclusoes, anteriores, janela, pendencias] = await Promise.all([
    q('SELECT login, nome, board_id FROM escreventes WHERE ativo ORDER BY nome'),
    q('SELECT tipo_ato, descricao, peso, horas_referencia FROM pesos_ato'),
    q(`SELECT * FROM conclusoes WHERE concluido_em >= $1 AND concluido_em < $2 ORDER BY escrevente, concluido_em`,
      [per.inicio, per.fim]),
    q(`SELECT escrevente, tipo_ato, retornos, reaberturas, historico_completo, horas_ativas, horas_mesa
         FROM conclusoes WHERE concluido_em >= $1 AND concluido_em < $2`, [ant.inicio, ant.fim]),
    q(`SELECT escrevente, tipo_ato, horas_ativas, historico_completo
         FROM conclusoes WHERE concluido_em >= $1 AND concluido_em < $2`, [inicioJanela, per.fim]),
    q(`SELECT escrevente, tipo, aberta_em, fechada_em, horas_uteis FROM pendencias
        WHERE (aberta_em IS NULL OR aberta_em < $2) AND (fechada_em IS NULL OR fechada_em >= $1)`,
      [per.inicio, per.fim])
  ]);
  const mapaPesos = {};
  for (const p of pesos.rows) mapaPesos[p.tipo_ato] = p;
  return {
    escreventes: esc.rows, pesos: mapaPesos, conclusoes: conclusoes.rows, anteriores: anteriores.rows,
    janela: janela.rows, pendencias: pendencias.rows, wip: wip ? await wipAtual(esc.rows) : null
  };
}

// Relatório pronto (não envia): { rel, assunto, html, texto, csv, para, homologacao }
async function gerar(tipo, dataRef, opcoes = {}) {
  const per = periodo(tipo, dataRef);
  const d = await coletar(tipo, per, opcoes);
  const rel = reports.calcular({ tipo, periodo: per, ...d });
  rel.pesos = d.pesos;
  const { para, homologacao } = email.destinatarios();
  const expediente = cal.calendario.faixas
    .map(([a, b]) => [a, b].map(m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`).join('-'))
    .join(', ');
  const nomes = Object.fromEntries(d.escreventes.map(e => [e.login, e.nome]));
  return {
    rel, para, homologacao,
    assunto: email.assunto(rel, homologacao),
    html: email.html(rel, { homologacao, expediente }),
    texto: email.texto(rel, homologacao),
    csv: email.csv(d.conclusoes, d.pesos, nomes),
    nomeCsv: `relatorio-${tipo}-${per.inicioISO}_${per.fimISO}.csv`
  };
}

function resumo(rel) {
  return {
    concluidos: rel.equipe.concluidos, pontos: rel.equipe.pontos, mediana_mesa: rel.equipe.mediana_mesa,
    taxa_retorno: rel.equipe.taxa_retorno,
    escreventes: rel.escreventes.map(e => ({ login: e.login, concluidos: e.concluidos, indice_custo: e.indice_custo }))
  };
}

async function gerarEEnviar(tipo, dataRef, idEnvio) {
  const g = await gerar(tipo, dataRef);
  const r = await email.enviar({
    para: g.para, assunto: g.assunto, html: g.html, texto: g.texto,
    anexos: [{ nome: g.nomeCsv, tipo: 'text/csv; charset=utf-8', conteudo: g.csv }]
  });
  await q(`UPDATE envios_relatorio SET status = 'enviado', enviado_em = now(), atualizado_em = now(),
           destinatarios = $2, resumo = $3, erro = NULL WHERE id = $1`,
    [idEnvio, g.para.join(', '), JSON.stringify({ ...resumo(g.rel), provedor: r.provedor, homologacao: g.homologacao })]);
  return { ...r, para: g.para, assunto: g.assunto, homologacao: g.homologacao };
}

async function falhou(idEnvio, e) {
  await q(`UPDATE envios_relatorio SET status = 'erro', erro = $2, atualizado_em = now() WHERE id = $1`,
    [idEnvio, String(e.message || e).slice(0, 500)]).catch(() => {});
}

// Envio automático: no máximo um por tipo e período. Reclama o período com um INSERT
// (dois servidores no ar não mandam em dobro); erro libera nova tentativa depois de
// 15 min, até 3; envio que ficou "enviando" (queda no meio) libera depois de 30 min.
// → { situacao: 'enviado' | 'resolvido' (já enviado ou tentativas esgotadas) | 'aguardando' }
async function enviarSeDevido(tipo, dataRef) {
  const per = periodo(tipo, dataRef);
  const r = await q(`
    INSERT INTO envios_relatorio (tipo, periodo_inicio, periodo_fim, status, por)
    VALUES ($1, $2, $3, 'enviando', 'agendador')
    ON CONFLICT (tipo, periodo_inicio) WHERE NOT manual DO UPDATE
       SET status = 'enviando', tentativas = envios_relatorio.tentativas + 1, atualizado_em = now()
     WHERE (envios_relatorio.status = 'erro' AND envios_relatorio.tentativas < 3
            AND envios_relatorio.atualizado_em < now() - interval '15 minutes')
        OR (envios_relatorio.status = 'enviando' AND envios_relatorio.atualizado_em < now() - interval '30 minutes')
    RETURNING id`, [tipo, per.inicioISO, per.fimISO]);
  if (!r.rowCount) {
    const s = (await q(`SELECT status, tentativas FROM envios_relatorio
                         WHERE tipo = $1 AND periodo_inicio = $2 AND NOT manual`, [tipo, per.inicioISO])).rows[0];
    const final = s && (s.status === 'enviado' || (s.status === 'erro' && s.tentativas >= 3));
    return { situacao: final ? 'resolvido' : 'aguardando' };
  }
  const id = r.rows[0].id;
  try {
    const res = await gerarEEnviar(tipo, dataRef, id);
    console.log(`[relatórios] ${tipo} ${per.inicioISO}→${per.fimISO} enviado para ${res.para.join(', ')} (${res.provedor})`);
    return { situacao: 'enviado', ...res };
  } catch (e) {
    await falhou(id, e);
    throw e;
  }
}

async function enviarManual(tipo, dataRef, por) {
  const per = periodo(tipo, dataRef);
  const r = await q(`INSERT INTO envios_relatorio (tipo, periodo_inicio, periodo_fim, manual, status, por)
                     VALUES ($1, $2, $3, true, 'enviando', $4) RETURNING id`, [tipo, per.inicioISO, per.fimISO, por || null]);
  const id = r.rows[0].id;
  try { return await gerarEEnviar(tipo, dataRef, id); } catch (e) { await falhou(id, e); throw e; }
}

// ------------------------------------------------------------ rotas de administração
const router = express.Router();
const json = express.json({ limit: '64kb' });

function admins() {
  return String(process.env.RELATORIOS_ADMINS || process.env.HUB_ADMINS || 'cesar.bravo')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
async function exigeAdmin(req, res, next) {
  res.set('Cache-Control', 'no-store');
  try {
    const sess = await db.sessaoValida(req.get('X-Auth-Token') || '');
    if (!sess) return res.status(401).json({ erro: 'sessão inválida ou expirada — entre de novo' });
    if (!admins().includes(String(sess.login || '').toLowerCase())) {
      return res.status(403).json({ erro: 'só o Tabelião vê os relatórios das escreventes' });
    }
    req.usuario = sess;
    next();
  } catch (e) {
    console.error('[relatórios] sessão:', e.message);
    res.status(500).json({ erro: 'falha ao validar a sessão' });
  }
}
router.use(exigeAdmin);
// na trilha de auditoria do hub: só o que foi feito, nunca o conteúdo do relatório
const auditar = (req, detalhe) => require('./hub').auditar(req, 'admin', 'relatorios', detalhe);

// Webhooks do token do hub (os do setup.js) que batem com a URL da assinatura, e os
// quadros monitorados que ficaram sem nenhum ativo. O token vai no caminho da API do
// Trello: nunca volta na resposta nem no log.
async function webhooksNoTrello() {
  const token = process.env.TRELLO_TOKEN;
  if (!process.env.TRELLO_KEY || !token) return null;
  try {
    const urls = rastreio.urlsDoWebhook();
    const todos = await trello.t('GET', `/tokens/${token}/webhooks`);
    const ativos = todos.filter(w => w.active && urls.includes(w.callbackURL));
    const cobertos = new Set(ativos.map(w => w.idModel));
    return {
      ativos: ativos.length,
      quadros_sem_webhook: (await require('./carga_retroativa').quadrosMonitorados()).filter(b => !cobertos.has(b)),
      outras_urls: [...new Set(todos.filter(w => !urls.includes(w.callbackURL)).map(w => w.callbackURL))]
    };
  } catch (e) {
    console.error('[relatórios] webhooks:', String(e.message).split(token).join('***'));
    return { erro: 'não foi possível consultar os webhooks no Trello' };
  }
}

function lerPedido(origem) {
  const tipo = String(origem.tipo || 'semanal');
  const ref = String(origem.ref || cal.local().data);
  if (!TIPOS.includes(tipo)) throw Object.assign(new Error('tipo deve ser semanal ou mensal'), { status: 400 });
  if (!RE_DATA.test(ref)) throw Object.assign(new Error('ref deve ser AAAA-MM-DD'), { status: 400 });
  return { tipo, ref };
}

router.get('/status', async (req, res) => {
  try {
    const [ev, conc, env, webhooks] = await Promise.all([
      q(`SELECT count(*)::int AS eventos, count(DISTINCT card_id)::int AS cartoes, max(ocorrido_em) AS ultimo,
                count(*) FILTER (WHERE processado_em IS NULL)::int AS pendentes,
                count(*) FILTER (WHERE origem = 'webhook')::int AS via_webhook FROM eventos_trello`),
      q(`SELECT count(*)::int AS conclusoes, count(*) FILTER (WHERE tipo_ato = 'OUTROS')::int AS sem_tipo FROM conclusoes`),
      q(`SELECT tipo, periodo_inicio, status, enviado_em FROM envios_relatorio ORDER BY id DESC LIMIT 1`),
      webhooksNoTrello()
    ]);
    const { para, homologacao } = email.destinatarios();
    res.json({
      rastreio: {
        ...ev.rows[0], ...conc.rows[0], webhook_assinado: !!process.env.TRELLO_SECRET, callback: rastreio.urlDoWebhook(),
        assinaturas_invalidas: rastreio.assinaturasInvalidas()   // desde o último reinício
      },
      webhooks,
      email: { provedor: email.provedor(), configurado: email.configurado(), para, homologacao },
      ultimo_envio: env.rows[0] || null,
      carga: estadoCarga
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.get('/previa', async (req, res) => {
  try {
    const { tipo, ref } = lerPedido(req.query);
    const g = await gerar(tipo, ref, { wip: req.query.wip !== '0' });
    auditar(req, `prévia ${tipo} ${ref}`);
    const formato = String(req.query.formato || 'html');
    if (formato === 'json') return res.json({ assunto: g.assunto, para: g.para, homologacao: g.homologacao, relatorio: g.rel });
    if (formato === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${g.nomeCsv}"`);
      res.set('Access-Control-Expose-Headers', 'Content-Disposition');   // o site do hub é outro domínio
      return res.send(g.csv);
    }
    res.set('Content-Type', 'text/html; charset=utf-8').send(g.html);
  } catch (e) { res.status(e.status || 500).json({ erro: e.message }); }
});

router.post('/enviar', json, async (req, res) => {
  try {
    const { tipo, ref } = lerPedido(req.body || {});
    const r = await enviarManual(tipo, ref, req.usuario.login);
    auditar(req, `envio manual ${tipo} ${ref}`);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(e.status || 500).json({ erro: e.message }); }
});

router.get('/envios', async (req, res) => {
  try {
    const r = await q(`SELECT id, tipo, periodo_inicio, periodo_fim, manual, status, tentativas, destinatarios, erro,
                              por, criado_em, enviado_em FROM envios_relatorio ORDER BY id DESC LIMIT 30`);
    res.json({ envios: r.rows });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// A carga leva minutos: roda em segundo plano, uma de cada vez; o andamento sai no /status.
let estadoCarga = null;
router.post('/carga', json, (req, res) => {
  const desde = String((req.body && req.body.desde) || '2026-06-01');
  if (!RE_DATA.test(desde)) return res.status(400).json({ erro: 'desde deve ser AAAA-MM-DD' });
  if (estadoCarga && estadoCarga.situacao === 'rodando') return res.status(409).json({ erro: 'já há uma carga rodando', carga: estadoCarga });
  estadoCarga = { situacao: 'rodando', desde, iniciada_em: new Date().toISOString(), por: req.usuario.login };
  auditar(req, `carga retroativa desde ${desde}`);
  require('./carga_retroativa').carga({ desde, log: m => { estadoCarga.ultima_mensagem = m; } })
    .then(r => { estadoCarga = { ...estadoCarga, situacao: 'concluida', resultado: r, fim: new Date().toISOString() }; })
    .catch(e => { estadoCarga = { ...estadoCarga, situacao: 'erro', erro: e.message, fim: new Date().toISOString() }; });
  res.status(202).json({ ok: true, carga: estadoCarga });
});

router.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'requisição inválida' });
  next(err);
});

module.exports = { router, periodo, periodoAnterior, gerar, enviarSeDevido, enviarManual, wipAtual };
