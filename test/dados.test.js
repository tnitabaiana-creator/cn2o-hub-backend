'use strict';
// v1.39.4 — segurança, pacote D: dados pessoais (minutas, trilha, logs e e-mail).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');
const db = require('../db');

// ---------------------------------------------------------------- banco simulado
const USUARIOS = {
  'tok-lara': { login: 'lara.silva', nome: 'Lara', cargo: 'Escrevente' },
  'tok-camily': { login: 'camily.oliveira', nome: 'Camily', cargo: 'Escrevente' },
  'tok-cesar': { login: 'cesar.bravo', nome: 'César', cargo: 'Tabelião' }
};
const minutas = new Map();
const auditoria = [];
let expurgoMinutas = null;
let base, srv;
test.before(async () => {
  db.sessaoValida = async t => USUARIOS[t] || null;
  db.pool.query = async (sql, p) => {
    if (/INSERT INTO hub_minutas/.test(sql)) { minutas.set(p[0], { id: p[0], titulo: p[1], texto: p[2], criado_por: p[3], doc_url: p[4] }); return { rows: [] }; }
    if (/SELECT .* FROM hub_minutas/s.test(sql)) {
      assert.match(sql, /criado_por = \$2 OR \$3/);
      const m = minutas.get(p[0]);
      return { rows: m && (m.criado_por === p[1] || p[2] === true) ? [m] : [] };
    }
    if (/DELETE FROM hub_minutas/.test(sql)) { expurgoMinutas = p[0]; return { rows: [] }; }
    if (/INSERT INTO hub_auditoria/.test(sql)) { auditoria.push(p); return { rows: [] }; }
    return { rows: [] };
  };
  process.env.HUB_GERADOR_LIBERADO = '1';
  const app = express();
  app.use('/hub', require('../hub'));
  srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  base = 'http://127.0.0.1:' + srv.address().port;
});
test.after(() => { srv.close(); delete process.env.HUB_GERADOR_LIBERADO; });
const pedir = (rota, tok, corpo) => fetch(base + rota, {
  method: corpo ? 'POST' : 'GET',
  headers: { 'Content-Type': 'application/json', 'X-Auth-Token': tok || '' },
  body: corpo ? JSON.stringify(corpo) : undefined
}).then(async r => ({ status: r.status, corpo: await r.json().catch(() => ({})) }));

test('minutas: id aleatório; só quem guardou (ou o Tabelião) abre; expurgo em 90 dias', async () => {
  const g = await pedir('/hub/minutas', 'tok-lara', { titulo: 'Escritura — Fulano', texto: 'MINUTA com CPF 123.456.789-01' });
  assert.equal(g.status, 200);
  assert.match(g.corpo.id, /^[A-Za-z0-9_-]{16}$/);                    // 12 bytes aleatórios, não mais relógio
  const outro = await pedir('/hub/minutas', 'tok-lara', { texto: 'outra' });
  assert.notEqual(outro.corpo.id.slice(0, 6), g.corpo.id.slice(0, 6));

  assert.equal((await pedir('/hub/minutas/' + g.corpo.id, 'tok-lara')).status, 200);    // a dona
  assert.equal((await pedir('/hub/minutas/' + g.corpo.id, 'tok-cesar')).status, 200);   // o Tabelião
  const colega = await pedir('/hub/minutas/' + g.corpo.id, 'tok-camily');
  assert.equal(colega.status, 404);                                     // colega: "não encontrada"
  assert.doesNotMatch(JSON.stringify(colega.corpo), /CPF|Fulano/);

  assert.equal(expurgoMinutas, '90');
});

test('trilha do acervo: CPF digitado no filtro entra mascarado', async () => {
  await pedir('/hub/acervo?partes=' + encodeURIComponent('Maria 123.456.789-01') + '&texto=12345678901&livro=12', 'tok-lara');
  await new Promise(r => setTimeout(r, 50));                            // a trilha grava em segundo plano
  const linha = auditoria.find(p => p[1] === 'acervo');
  assert.ok(linha, 'a pesquisa entrou na trilha');
  assert.match(linha[3], /partes=Maria \*\*\*\.456\.789-\*\*/);
  assert.match(linha[3], /texto=\*\*\*\.456\.789-\*\*/);
  assert.match(linha[3], /livro=12/);                                   // número que não é CPF fica
  assert.doesNotMatch(linha[3], /123\.?456|789-?01/);
});

test('WhatsApp: o log não guarda telefone inteiro nem os dados do recibo', async () => {
  const whats = require('../whats');
  const antes = { fetch: global.fetch, url: process.env.WHATS_URL, tok: process.env.WHATS_TOKEN, tpl: process.env.WHATS_TEMPLATE_RECIBO };
  const saida = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ['log', 'warn', 'error']) console[k] = (...a) => saida.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
  process.env.WHATS_URL = 'https://graph.exemplo/v1/messages'; process.env.WHATS_TOKEN = 't';
  process.env.WHATS_TEMPLATE_RECIBO = 'recibo_protocolo_3';
  let chamada = 0;
  global.fetch = async () => (++chamada === 1
    ? { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) }
    : { ok: false, status: 400, json: async () => ({ error: { message: 'Invalid parameter', code: 100 } }) });
  try {
    await whats.dispararRecibos({
      ato: 'CV', apresentante: { nome: 'JOANA APRESENTANTE', telefone: '(79) 99876-5432' },
      parte_envolvida: { nome: 'PEDRO COMPRADOR', telefone: '79 98888-7777' }
    }, '001234');
    await whats.dispararRecibos({ apresentante: { telefone: '12' }, parte_envolvida: { telefone: '' } }, '001235');
  } finally {
    Object.assign(console, orig);
    global.fetch = antes.fetch;
    for (const [k, v] of [['WHATS_URL', antes.url], ['WHATS_TOKEN', antes.tok], ['WHATS_TEMPLATE_RECIBO', antes.tpl]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const log = saida.join('\n');
  assert.match(log, /disparando recibo .*5 variáveis/);
  assert.match(log, /5432/);                                           // os 4 últimos dígitos ajudam a conferir
  assert.doesNotMatch(log, /99876|98888|79998|JOANA|PEDRO/);
  const hist = whats.statusWhatsApp().ultimos_envios || [];
  assert.doesNotMatch(JSON.stringify(hist.map(h => h.motivo || '')), /99876|98888/);
});

test('transposição sem JSON: o log leva só o tamanho e o formato, nunca o começo da resposta', () => {
  const hub = fs.readFileSync(path.join(__dirname, '..', 'hub.js'), 'utf8');
  assert.doesNotMatch(hub, /início da resposta: ' \+ JSON\.stringify\(String\(r\.texto/);
  assert.match(hub, /caracteres, começa com/);
});

test('Apps Script do e-mail: só manda para a lista DESTINATARIOS, mesmo com o segredo certo', () => {
  const codigo = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'EnviarRelatorio.gs'), 'utf8');
  function rodar(props, para) {
    const enviados = [];
    const caixa = {
      PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null }) },
      MailApp: { sendEmail: o => enviados.push(o.to), getRemainingDailyQuota: () => 99 },
      Utilities: { newBlob: () => ({}), base64Decode: () => [] },
      ContentService: { createTextOutput: s => ({ setMimeType: () => JSON.parse(s) }), MimeType: { JSON: 'json' } }
    };
    vm.runInNewContext(codigo, caixa);
    const r = caixa.doPost({ postData: { contents: JSON.stringify({ segredo: 's3', versao: 1, para, assunto: 'a', html: '<p>x</p>' }) } });
    return { r, enviados };
  }
  const lista = { SEGREDO: 's3', DESTINATARIOS: 'tnitabaiana@gmail.com, sergiolagofula2@gmail.com' };
  assert.deepEqual(rodar(lista, ['TNITABAIANA@gmail.com']).enviados, ['TNITABAIANA@gmail.com']);
  const fora = rodar(lista, ['tnitabaiana@gmail.com', 'alvo@exemplo.com']);
  assert.equal(fora.r.ok, false);
  assert.deepEqual(fora.enviados, []);                                  // nem os permitidos saem junto
  const semLista = rodar({ SEGREDO: 's3' }, ['tnitabaiana@gmail.com']);
  assert.equal(semLista.r.ok, false);
  assert.match(semLista.r.erro, /DESTINATARIOS/);
});
