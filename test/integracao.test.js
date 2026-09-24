'use strict';
// Integração com Postgres de verdade: sobe o server.js do hub, manda webhooks
// assinados, roda a carga retroativa contra um Trello simulado e gera o relatório.
// O servidor fala com um Trello simulado (test/trello-falso.js), para conferir que a
// re-hidratação dos campos continua de pé ao lado do rastreio.
//   TEST_DATABASE_URL=postgres://… npm test
// Use um banco DESCARTÁVEL: o teste apaga as tabelas do rastreio e a de protocolos.
// Sem a variável, o teste é pulado.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const URL_DB = process.env.TEST_DATABASE_URL;
const RAIZ = path.join(__dirname, '..');
const SEGREDO = 'segredo-de-teste';
const H = s => new Date(s + ':00-03:00').toISOString();
const esperar = ms => new Promise(r => setTimeout(r, ms));

// Trello simulado: guarda cada chamada e responde o mínimo que o hub precisa.
function trelloFalso(base, quadros) {
  const chamadas = [];
  const srv = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', d => { corpo += d; });
    req.on('end', () => {
      const caminho = new URL(req.url, 'http://x').pathname;
      chamadas.push({ metodo: req.method, caminho, corpo: corpo ? JSON.parse(corpo) : null });
      let r = req.method === 'GET' ? [] : {};
      if (caminho === '/1/tokens/token-falso/webhooks') {
        r = [{ id: 'w1', idModel: quadros.B00, callbackURL: base + '/webhook/trello', active: true },
          { id: 'w2', idModel: quadros.BL, callbackURL: 'https://antigo.exemplo/webhook/trello', active: true }];
      } else if (/^\/1\/boards\/[^/]+\/customFields$/.test(caminho)) {
        r = [{ id: 'cf-protocolo', name: 'Protocolo', type: 'number' }, { id: 'cf-ato', name: 'Tipo de Ato', type: 'text' }];
      } else if (/^\/1\/boards\/[^/]+\/labels$/.test(caminho)) {
        r = [{ id: 'lb-urgente', name: 'Urgente' }];
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(r));
    });
  });
  return { srv, chamadas };
}

test('integração no hub: webhook → rastreio → carga retroativa → relatório', {
  skip: !URL_DB && 'defina TEST_DATABASE_URL (Postgres descartável) para rodar'
}, async t => {
  const saida = fs.mkdtempSync(path.join(os.tmpdir(), 'cn2o-rel-'));
  Object.assign(process.env, {
    DATABASE_URL: URL_DB, RELATORIO_EMAIL_PROVEDOR: 'arquivo', RELATORIO_SAIDA_DIR: saida,
    TRELLO_KEY: '', TRELLO_TOKEN: ''
  });
  for (const k of ['RELATORIO_EMAIL_PARA', 'HUB_ADMINS', 'RELATORIOS_ADMINS', 'TRELLO_WEBHOOK_URL', 'BOARDS_ESCREVENTES']) delete process.env[k];
  const db = require('../db');
  const q = (s, p) => db.pool.query(s, p);
  await q(`DROP TABLE IF EXISTS eventos_trello, passagens, pendencias, conclusoes, pesos_ato, envios_relatorio, escreventes, protocolos CASCADE`);
  const inicio = (await q('SELECT now() AS agora')).rows[0].agora;

  const { ESCREVENTES } = require('../db-relatorios');
  const [, , boardLara, finalLara] = ESCREVENTES.find(e => e[0] === 'lara.silva');
  const B00 = { id: '692e0379fa55156e778f27ef', name: '00. Protocolo/Cadastro' };
  const BL = { id: boardLara, name: '02. ESCREVENTE LARA' };

  const porta = 3900 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${porta}`;
  const falso = trelloFalso(base, { B00: B00.id, BL: BL.id });
  await new Promise(r => falso.srv.listen(0, '127.0.0.1', r));
  let log = '';
  const srv = spawn(process.execPath, ['-r', path.join(__dirname, 'trello-falso.js'), 'server.js'], {
    cwd: RAIZ,
    env: {
      ...process.env, PORT: String(porta), TRELLO_SECRET: SEGREDO, BASE_URL: base,
      TRELLO_KEY: 'chave-falsa', TRELLO_TOKEN: 'token-falso', TRELLO_FALSO_URL: `http://127.0.0.1:${falso.srv.address().port}`
    }
  });
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });
  t.after(async () => { srv.kill(); falso.srv.close(); await db.pool.end(); });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/saude')).ok) break; } catch (_) { /* subindo */ }
    await esperar(200);
    if (i === 149) throw new Error('servidor não subiu:\n' + log);
  }

  // o e-Protocolo do hub: cartões protocolados (tipo de ato canônico e re-hidratação)
  const prot = (numero, dados, card) => q(`INSERT INTO protocolos (numero, dados, card_id) VALUES ($1, $2, $3)`, [numero, dados, card]);
  await prot(1777, { ato: 'CV-Rural' }, 'card-protocolado');
  await prot(1778, { ato: 'CDH', apresentante: { nome: 'APRESENTANTE' }, parte_envolvida: { nome: 'PARTE' }, urgente: true }, 'card-reidratar');
  await prot(1779, { ato: 'DOA' }, 'card-reidratar-2');
  // sessões do hub: o Tabelião (administrador padrão) e uma escrevente
  const sessao = async login => {
    const token = crypto.randomBytes(16).toString('hex');
    await q(`INSERT INTO sessoes (token, login, expira) VALUES ($1, $2, now() + interval '1 hour')`, [token, login]);
    return token;
  };
  const tokTabeliao = await sessao('cesar.bravo');
  const tokLara = await sessao('lara.silva');

  const assinar = corpo => crypto.createHmac('sha1', SEGREDO)
    .update(Buffer.concat([Buffer.from(corpo), Buffer.from(base + '/webhook/trello')])).digest('base64');
  const webhook = (action, assinatura) => {
    const corpo = JSON.stringify({ model: { id: 'board' }, action });
    return fetch(base + '/webhook/trello', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Trello-Webhook': assinatura === undefined ? assinar(corpo) : assinatura },
      body: corpo
    });
  };
  const aguardarProcessado = async cardId => {
    for (let i = 0; i < 100; i++) {
      const r = await q(`SELECT count(*) FILTER (WHERE processado_em IS NULL)::int AS n FROM eventos_trello WHERE card_id = $1`, [cardId]);
      if (r.rows[0].n === 0) return;
      await esperar(100);
    }
    throw new Error('reconstrução não terminou');
  };
  const aguardar = async (condicao, oQue) => {
    for (let i = 0; i < 100; i++) { if (await condicao()) return; await esperar(100); }
    throw new Error(oQue + ' não aconteceu:\n' + log);
  };

  const Ls = {
    entrada: { id: '692e04b1eb7cbc358301a32e', name: 'Protocolo/Entrada' }, arquivo: { id: '69344a6fc5e00099568028f9', name: 'Arquivo Geral' },
    revisar: { id: '692e0a2c4ad155c0fcd88ab8', name: 'Revisar Minuta' }, conf: { id: '692e0a44b382b57311bf7f6c', name: 'Conferência de Minuta' },
    ajuste: { id: '692e0a503ae84e9e7e80289f', name: 'Ajuste/Retorno' }, agendar: { id: '692e0a67e86ea541264e56c9', name: 'Agendar Assinatura' },
    final: { id: finalLara, name: 'Finalizado' }, arquivar: { id: '694d86f07fee102e3cc9fc94', name: 'Arquivar' }
  };
  const CARD = { id: 'card-teste-1', name: 'Prot. (CDH) 1500 - ROMÊNIA DE JESUS', shortLink: 'tst1' };
  let n = 0;
  const acao = (type, quando, data) => ({ id: 'act' + String(++n).padStart(6, '0'), type, date: H(quando), data: { card: CARD, ...data } });
  const mover = (quando, de, para) => acao('updateCard', quando, { board: BL, listBefore: de, listAfter: para, old: { idList: de.id } });

  await t.test('Task 1 — as sete tabelas existem', async () => {
    const r = await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      AND table_name IN ('eventos_trello','passagens','pendencias','conclusoes','pesos_ato','escreventes','envios_relatorio')`);
    assert.equal(r.rowCount, 7);
  });

  await t.test('Task 2 — SELECT * FROM escreventes devolve os 5 registros da Fase 0', async () => {
    const r = await q('SELECT login, nome, board_id, list_finalizado_id FROM escreventes ORDER BY login');
    assert.deepEqual(r.rows.map(x => [x.login, x.nome, x.board_id, x.list_finalizado_id]),
      [...ESCREVENTES].sort((a, b) => a[0].localeCompare(b[0])));
    assert.equal((await q('SELECT count(*)::int AS n FROM pesos_ato')).rows[0].n, Object.keys(require('../tipos-ato').TIPOS).length);
  });

  const criar = acao('createCard', '2026-09-14T09:00', { board: B00, list: Ls.entrada });

  await t.test('Task 3 — assinatura válida grava; inválida ou ausente não grava (e o Trello recebe 200); repetida não duplica', async () => {
    assert.equal((await webhook(criar, 'assinatura-falsa')).status, 200);
    assert.equal((await webhook(criar, '')).status, 200);
    assert.equal((await q('SELECT count(*)::int AS n FROM eventos_trello')).rows[0].n, 0);
    assert.equal((await webhook(criar)).status, 200);
    assert.equal((await webhook(criar)).status, 200);                 // reentrega do Trello
    const r = await q('SELECT action_id, tipo, card_id, board_id, origem FROM eventos_trello');
    assert.deepEqual(r.rows, [{ action_id: criar.id, tipo: 'createCard', card_id: CARD.id, board_id: B00.id, origem: 'webhook' }]);
    assert.equal((await webhook({ id: 'x1', type: 'commentCard', date: H('2026-09-14T09:01'), data: { card: CARD } })).status, 200);
    assert.equal((await q('SELECT count(*)::int AS n FROM eventos_trello')).rows[0].n, 1);   // comentário não entra
  });

  await t.test('Task 4 — ida, volta e troca de quadro: passagens e conclusão corretas, sem duplicar', async () => {
    const ciclo = [
      acao('moveCardFromBoard', '2026-09-14T10:00', { board: B00, boardTarget: { id: BL.id }, list: Ls.entrada }),
      acao('moveCardToBoard', '2026-09-14T10:00', { board: BL, boardSource: { id: B00.id }, list: Ls.revisar }),
      mover('2026-09-15T10:00', Ls.revisar, Ls.conf), mover('2026-09-15T14:00', Ls.conf, Ls.ajuste),
      mover('2026-09-16T09:00', Ls.ajuste, Ls.conf), mover('2026-09-16T11:00', Ls.conf, Ls.agendar),
      mover('2026-09-17T10:00', Ls.agendar, Ls.final), mover('2026-09-17T11:00', Ls.final, Ls.ajuste),
      mover('2026-09-17T15:00', Ls.ajuste, Ls.final), mover('2026-09-18T09:00', Ls.final, Ls.arquivar),
      acao('moveCardFromBoard', '2026-09-18T10:00', { board: BL, boardTarget: { id: B00.id }, list: Ls.arquivar }),
      acao('moveCardToBoard', '2026-09-18T10:00', { board: B00, boardSource: { id: BL.id }, list: Ls.arquivo })
    ];
    for (const a of ciclo) assert.equal((await webhook(a)).status, 200);
    for (const a of [...ciclo].reverse()) assert.equal((await webhook(a)).status, 200);    // tudo de novo, fora de ordem
    await aguardarProcessado(CARD.id);
    assert.equal((await q('SELECT count(*)::int AS n FROM eventos_trello')).rows[0].n, 13);
    const p = await q(`SELECT list_nome, categoria, escrevente, horas_uteis FROM passagens WHERE card_id = $1 ORDER BY entrou_em`, [CARD.id]);
    assert.deepEqual(p.rows.map(x => [x.list_nome, x.horas_uteis]), [
      ['Protocolo/Entrada', 1], ['Revisar Minuta', 8], ['Conferência de Minuta', 3], ['Ajuste/Retorno', 4],
      ['Conferência de Minuta', 2], ['Agendar Assinatura', 7], ['Finalizado', 1], ['Ajuste/Retorno', 3],
      ['Finalizado', 3], ['Arquivar', 1], ['Arquivo Geral', null]
    ]);
    const c = (await q('SELECT * FROM conclusoes')).rows;
    assert.equal(c.length, 1);
    assert.equal(c[0].escrevente, 'lara.silva');
    assert.equal(c[0].tipo_ato, 'CDH');
    assert.equal(c[0].protocolo, 1500);
    assert.equal(c[0].reaberturas, 1);
    assert.equal(c[0].horas_mesa, 28);
    assert.equal(c[0].horas_ativas, 15);
    assert.equal(c[0].concluido_em.toISOString(), H('2026-09-17T10:00'));
    assert.equal((await q('SELECT count(*)::int AS n FROM pendencias WHERE card_id = $1', [CARD.id])).rows[0].n, 2);
    // reprocessar tudo dá o mesmo resultado
    await require('../rastreio').reprocessar({ todos: true });
    assert.equal((await q('SELECT count(*)::int AS n FROM passagens')).rows[0].n, 11);
    assert.equal((await q('SELECT count(*)::int AS n FROM conclusoes')).rows[0].n, 1);
  });

  await t.test('Task 5 — carga retroativa: consome a paginação e não duplica ao rodar de novo', async () => {
    const titulos = ['Prot. (CV-Urbano) -1063 extra 1521', 'Prot. (CDP) -1142 extra 1650', 'Prot. (TESTAMENTO-AMORIM) -1217',
      'Prot. (Ata WhatsApp) -1175 EXTRA 1645', 'Prot. (DOA) -1308; Extra: 1801'];
    const todas = [];
    let k = 0;
    const nova = (type, quando, data) => ({ id: 'hist' + String(++k).padStart(6, '0'), type, date: new Date(quando).toISOString(), data });
    for (let i = 0; i < 500; i++) {
      const card = { id: 'hist-card-' + i, name: titulos[i % titulos.length], shortLink: 'h' + i };
      const t0 = new Date(H('2026-09-15T08:00')).getTime() + i * 60e3;
      todas.push(nova('createCard', t0, { card, board: BL, list: Ls.revisar }));
      todas.push(nova('updateCard', t0 + 30 * 60e3, { card, board: BL, listBefore: Ls.revisar, listAfter: Ls.conf }));
      todas.push(nova('updateCard', t0 + 60 * 60e3, { card, board: BL, listBefore: Ls.conf, listAfter: Ls.final }));
      todas.push(nova('updateCard', t0 + 90 * 60e3, { card, board: BL, listBefore: Ls.final, listAfter: Ls.arquivar }));
      todas.push(nova('commentCard', t0 + 95 * 60e3, { card, board: BL }));             // fica de fora
    }
    // o cartão do webhook também aparece no histórico (sobreposição com o que já entrou)
    todas.push({ ...criar });
    todas.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));    // Trello: mais nova primeiro
    const chamadas = [];
    const falsoTrello = async (metodo, caminho) => {
      chamadas.push(caminho);
      const qs = new URLSearchParams(caminho.split('?')[1]);
      assert.equal(qs.get('filter').includes('updateCard:idList'), true);
      const antes = qs.get('before');
      const desde = new Date(qs.get('since')).getTime();
      const inicioPagina = antes ? todas.findIndex(a => a.id === antes) + 1 : 0;
      return todas.slice(inicioPagina).filter(a => new Date(a.date).getTime() >= desde).slice(0, +qs.get('limit'));
    };
    const { carga } = require('../carga_retroativa');
    const r1 = await carga({ desde: '2026-06-01', quadros: [BL.id], t: falsoTrello, log: () => {} });
    assert.equal(chamadas.length, 3);                       // 1000 + 1000 + 501
    assert.ok(chamadas[1].includes('before='));
    assert.equal(r1.lidas, 2501);
    assert.equal(r1.novas, 2000);                           // 500 × 4; comentário fora; o createCard já existia
    assert.equal(r1.cartoes, 501);
    assert.deepEqual(r1.rotulos_nao_reconhecidos, []);
    const r2 = await carga({ desde: '2026-06-01', quadros: [BL.id], t: falsoTrello, log: () => {} });
    assert.equal(r2.novas, 0);
    assert.equal((await q('SELECT count(*)::int AS n FROM eventos_trello')).rows[0].n, 13 + 2000);
    assert.equal((await q('SELECT count(*)::int AS n FROM conclusoes')).rows[0].n, 501);
    const tipos = await q(`SELECT tipo_ato, count(*)::int AS n FROM conclusoes WHERE card_id LIKE 'hist-%' GROUP BY 1 ORDER BY 1`);
    assert.deepEqual(tipos.rows, [
      { tipo_ato: 'ATA-W/A', n: 100 }, { tipo_ato: 'CDP', n: 100 }, { tipo_ato: 'CV-Urbano', n: 100 },
      { tipo_ato: 'DOA', n: 100 }, { tipo_ato: 'TEST', n: 100 }
    ]);
    // o cartão do webhook continua íntegro depois da carga por cima
    assert.equal((await q(`SELECT horas_mesa FROM conclusoes WHERE card_id = $1`, [CARD.id])).rows[0].horas_mesa, 28);
  });

  await t.test('o hub segue re-hidratando os campos ao trocar de quadro — com e sem assinatura válida', async () => {
    const putsDo = card => falso.chamadas.filter(c => c.metodo === 'PUT' && c.caminho.startsWith(`/1/cards/${card}/customField/`));
    const chegada = (card, id) => ({ id, type: 'moveCardToBoard', date: H('2026-09-22T08:30'),
      data: { card: { id: card, name: 'Prot. (CDH) 1778 - PARTE', shortLink: 'rh' }, board: BL, boardSource: { id: B00.id }, list: Ls.revisar } });
    // assinada: re-hidrata E entra no rastreio
    assert.equal((await webhook(chegada('card-reidratar', 'rh-1'))).status, 200);
    await aguardar(async () => putsDo('card-reidratar').length === 2, 're-hidratação do card-reidratar');
    assert.deepEqual(putsDo('card-reidratar').map(c => [c.caminho, c.corpo]), [
      ['/1/cards/card-reidratar/customField/cf-protocolo/item', { value: { number: '1778' } }],
      ['/1/cards/card-reidratar/customField/cf-ato/item', { value: { text: 'CDH' } }]
    ]);
    await aguardar(async () => falso.chamadas.some(c => c.metodo === 'POST' && c.caminho === '/1/cards/card-reidratar/idLabels'),
      'etiqueta Urgente reaplicada');
    await aguardarProcessado('card-reidratar');
    assert.equal((await q(`SELECT count(*)::int AS n FROM eventos_trello WHERE card_id = 'card-reidratar'`)).rows[0].n, 1);
    // assinatura errada: fica fora das métricas, mas a re-hidratação acontece como antes da v1.38
    assert.equal((await webhook(chegada('card-reidratar-2', 'rh-2'), 'assinatura-falsa')).status, 200);
    await aguardar(async () => putsDo('card-reidratar-2').length === 2, 're-hidratação do card-reidratar-2');
    assert.equal((await q(`SELECT count(*)::int AS n FROM eventos_trello WHERE card_id = 'card-reidratar-2'`)).rows[0].n, 0);
  });

  await t.test('Task 7 — relatório semanal gerado e enviado uma vez só (provedor arquivo)', async () => {
    const rel = require('../relatorios');
    const r = await rel.enviarSeDevido('semanal', '2026-09-21');
    assert.equal(r.situacao, 'enviado');
    assert.deepEqual(r.para, ['sergiolagofula2@gmail.com']);
    assert.equal(r.homologacao, true);
    const html = fs.readFileSync(r.id, 'utf8');
    assert.match(html, /Relatório semanal das escreventes/);
    assert.match(html, /14\/09 a 20\/09\/2026/);
    assert.match(html, /Lara/);
    const csvs = fs.readdirSync(saida).filter(f => f.endsWith('.csv'));
    assert.equal(csvs.length, 1);
    const linhas = fs.readFileSync(path.join(saida, csvs[0]), 'utf8').trim().split('\r\n');
    assert.equal(linhas.length, 1 + 501);                   // cabeçalho + atos concluídos na semana
    assert.equal((await rel.enviarSeDevido('semanal', '2026-09-21')).situacao, 'resolvido');
    const e = await q(`SELECT status, manual, tentativas FROM envios_relatorio`);
    assert.deepEqual(e.rows, [{ status: 'enviado', manual: false, tentativas: 1 }]);
    const g = await rel.gerar('semanal', '2026-09-21', { wip: false });
    const lara = g.rel.escreventes.find(x => x.login === 'lara.silva');
    assert.equal(lara.concluidos, 501);
    assert.equal(g.rel.equipe.concluidos, 501);
  });

  await t.test('Task 8 — agendador registrado no ciclo de vida do hub', async () => {
    assert.match(log, /CN2O hub no ar/);
    assert.match(log, /\[agendador\] ativo/);
  });

  await t.test('/hub/relatorios: só a sessão de administrador entra; prévia, CSV, envio manual e trilha de auditoria', async () => {
    const rota = base + '/hub/relatorios';
    assert.equal((await fetch(rota + '/status')).status, 401);
    assert.equal((await fetch(rota + '/previa', { headers: { 'X-Auth-Token': 'sessao-inexistente' } })).status, 401);
    assert.equal((await fetch(rota + '/status', { headers: { 'X-Auth-Token': tokLara } })).status, 403);   // escrevente não vê
    const adm = { 'X-Auth-Token': tokTabeliao };
    const st = await (await fetch(rota + '/status', { headers: adm })).json();
    assert.equal(st.rastreio.conclusoes, 501);
    assert.equal(st.rastreio.webhook_assinado, true);
    assert.equal(st.rastreio.assinaturas_invalidas.total, 3);            // 2 da Task 3 + 1 da re-hidratação
    assert.equal(st.webhooks.ativos, 1);
    assert.equal(st.webhooks.quadros_sem_webhook.length, 6);             // 7 quadros monitorados, só o 00 aponta para cá
    assert.ok(st.webhooks.quadros_sem_webhook.includes(BL.id));
    assert.deepEqual(st.webhooks.outras_urls, ['https://antigo.exemplo/webhook/trello']);
    assert.ok(!JSON.stringify(st).includes('token-falso'));
    assert.deepEqual(st.email, { provedor: 'arquivo', configurado: true, para: ['sergiolagofula2@gmail.com'], homologacao: true });
    const previa = await fetch(rota + '/previa?tipo=semanal&ref=2026-09-21', { headers: adm });
    assert.equal(previa.status, 200);
    assert.match(previa.headers.get('content-type'), /text\/html/);
    assert.equal(previa.headers.get('cache-control'), 'no-store');
    assert.match(await previa.text(), /Relatório semanal das escreventes/);
    const csv = await fetch(rota + '/previa?tipo=mensal&ref=2026-10-01&formato=csv', { headers: adm });
    assert.match(csv.headers.get('content-disposition'), /relatorio-mensal-2026-09-01_2026-09-30\.csv/);
    assert.equal((await csv.text()).trim().split('\r\n').length, 1 + 501);
    assert.equal((await fetch(rota + '/previa?tipo=anual', { headers: adm })).status, 400);
    const env = await fetch(rota + '/enviar', { method: 'POST', headers: { ...adm, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: 'semanal', ref: '2026-09-21' }) });
    assert.equal(env.status, 200);
    assert.equal((await env.json()).ok, true);
    const lista = await (await fetch(rota + '/envios', { headers: adm })).json();
    assert.deepEqual(lista.envios.map(e => [e.manual, e.status, e.por]), [[true, 'enviado', 'cesar.bravo'], [false, 'enviado', 'agendador']]);
    // na trilha do Tabelião: quem fez o quê, sem o conteúdo do relatório
    const trilha = async () => (await q(`SELECT login, acao, ferramenta, detalhe FROM hub_auditoria
      WHERE ferramenta = 'relatorios' AND em >= $1 ORDER BY id`, [inicio])).rows;
    await aguardar(async () => (await trilha()).length === 3, 'registro na trilha de auditoria');
    assert.deepEqual(await trilha(), [
      { login: 'cesar.bravo', acao: 'admin', ferramenta: 'relatorios', detalhe: 'prévia semanal 2026-09-21' },
      { login: 'cesar.bravo', acao: 'admin', ferramenta: 'relatorios', detalhe: 'prévia mensal 2026-10-01' },
      { login: 'cesar.bravo', acao: 'admin', ferramenta: 'relatorios', detalhe: 'envio manual semanal 2026-09-21' }
    ]);
    // o resto do /hub continua respondendo depois da montagem de /hub/relatorios
    const eu = await (await fetch(base + '/hub/eu', { headers: adm })).json();
    assert.equal(eu.admin, true);
  });

  await t.test('o tipo de ato vem do e-Protocolo do hub, não do título', async () => {
    const card = { id: 'card-protocolado', name: 'Prot. (DOA) 1777 - TESTE', shortLink: 'prt1' };
    const a1 = { id: 'prt-1', type: 'createCard', date: H('2026-09-22T09:00'), data: { card, board: BL, list: Ls.revisar } };
    const a2 = { id: 'prt-2', type: 'updateCard', date: H('2026-09-22T11:00'),
      data: { card, board: BL, listBefore: Ls.revisar, listAfter: Ls.final, old: { idList: Ls.revisar.id } } };
    for (const a of [a1, a2]) assert.equal((await webhook(a)).status, 200);
    await aguardarProcessado(card.id);
    const c = (await q(`SELECT tipo_ato, protocolo, horas_ativas FROM conclusoes WHERE card_id = $1`, [card.id])).rows[0];
    assert.deepEqual(c, { tipo_ato: 'CV-Rural', protocolo: 1777, horas_ativas: 2 });
  });
});
