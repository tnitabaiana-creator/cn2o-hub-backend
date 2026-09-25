'use strict';
// v1.39 — atendimentos do balcão (NextQS) sem n8n: cálculo, cliente da API, coleta, PDF e agenda.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../atendimentos');
const nextqs = require('../nextqs');
const { montarPdf } = require('../atendimentos-pdf');
const { devidosAtendimentos } = require('../agendador');
const { local } = require('../horas-uteis');
const db = require('../db');

const AGORA = Date.parse('2026-09-24T20:00:00Z');      // quinta, 17h em Sergipe
const senha = (o) => Object.assign({ queue_label: 'Escrituras', user_label: 'Lara', service_desk_label: 'Mesa', service_desk_number: 2, site_label: 'CN2O' }, o);

test('agregarPorDia: atendidas, ausentes, nunca chamadas, excluídas, fuso e horário de pico', () => {
  const dias = A.agregarPorDia([
    // 22/09 10:00 local, chamada 10:05, atendida 10:05–10:25
    senha({ ticket_generated_at: '2026-09-22T13:00:00Z', ticket_first_call_at: '2026-09-22T13:05:00Z', service_started_at: '2026-09-22T13:05:00Z', service_ended_at: '2026-09-22T13:25:00Z', csat: 5 }),
    // 22/09 ausente (no-show)
    senha({ ticket_generated_at: '2026-09-22T13:30:00Z', ticket_first_call_at: '2026-09-22T13:40:00Z', is_noshow_at: '2026-09-22T13:45:00Z' }),
    // 22/09 nunca chamada: dia já passou → não atendida
    senha({ ticket_generated_at: '2026-09-22T19:50:00Z' }),
    // 24/09 (hoje) ainda não chamada: não é "não atendida" ainda
    senha({ ticket_generated_at: '2026-09-24T14:00:00Z' }),
    // excluída no NextQS: fora da conta
    senha({ ticket_generated_at: '2026-09-22T14:00:00Z', is_deleted_at: '2026-09-22T14:01:00Z' }),
    // 23/09 01:30Z = 22/09 22:30 em Sergipe; fila em lista e atendente vazio
    senha({ ticket_generated_at: '2026-09-23T01:30:00Z', queue_label: ['Certidões', 'Traslado'], user_label: null }),
    // registro esquecido aberto (> 12 h) não entra nos tempos
    senha({ ticket_generated_at: '2026-09-23T12:00:00Z', service_started_at: '2026-09-23T12:10:00Z', service_ended_at: '2026-09-24T12:00:00Z' })
  ], '2026-09-21', '2026-09-24', AGORA);
  assert.deepEqual(dias.map(d => [d.dia, d.senhas]), [['2026-09-21', 0], ['2026-09-22', 4], ['2026-09-23', 1], ['2026-09-24', 1]]);
  const d22 = dias[1].dados;
  const lara = d22.r.find(r => r[0] === 'Escrituras');
  // [fila, atendente, guichê, unidade, emit, atend, não atend, Σesp, nEsp, Σatd, nAtd, Σcsat, nCsat]
  assert.deepEqual(lara, ['Escrituras', 'Lara', 'Mesa 2', 'CN2O', 3, 1, 2, 300 + 600, 2, 1200, 1, 5, 1]);
  const cert = d22.r.find(r => r[0] === 'Certidões, Traslado');
  assert.deepEqual(cert.slice(0, 7), ['Certidões, Traslado', '', 'Mesa 2', 'CN2O', 1, 0, 1]);
  assert.deepEqual(d22.h, [['10h', 2], ['16h', 1], ['22h', 1]]);
  const d23 = dias[2].dados.r[0];
  assert.equal(d23[5], 1);          // atendida
  assert.equal(d23[10], 0);         // mas a duração de 24 h não conta
  assert.deepEqual(dias[3].dados.r[0].slice(4, 7), [1, 0, 0]);   // hoje: emitida, ainda não "não atendida"
});

test('janelas de até 90 dias, da mais recente para a mais antiga', () => {
  assert.deepEqual(A.janelas('2026-09-20', '2026-09-24'), [['2026-09-20', '2026-09-24']]);
  const j = A.janelas('2026-01-01', '2026-09-24');
  assert.equal(j[0][1], '2026-09-24');
  assert.equal(j[j.length - 1][0], '2026-01-01');
  assert.equal(j.length, 3);
  for (let i = 1; i < j.length; i++) assert.equal(j[i][1] < j[i - 1][0], true);
});

function respostas(lista) {
  const chamadas = [];
  const fetch = async (url, op) => {
    chamadas.push({ url, auth: op.headers.Authorization });
    const r = lista.shift();
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300, status: r.status,
      headers: { get: k => (r.headers || {})[k.toLowerCase()] || null },
      json: async () => r.corpo, text: async () => JSON.stringify(r.corpo || '')
    };
  };
  return { fetch, chamadas };
}

test('cliente do NextQS: token Bearer, paginação, 404 = zero, erros claros sem o token', async () => {
  const antes = process.env.NEXTQS_TOKEN;
  process.env.NEXTQS_TOKEN = 'tok-secreto-123';
  try {
    const cheia = Array.from({ length: 500 }, (_, i) => ({ id: i }));
    const R = respostas([
      { status: 200, corpo: cheia, headers: { 'x-request-response-current-page': '1', 'x-request-response-total-pages': '2' } },
      { status: 200, corpo: [{ id: 500 }], headers: { 'x-request-response-current-page': '2', 'x-request-response-total-pages': '2' } }
    ]);
    const s = await nextqs.senhas('2026-09-01', '2026-09-24', { fetch: R.fetch, intervalo: 0 });
    assert.equal(s.length, 501);
    assert.equal(R.chamadas.length, 2);
    assert.equal(R.chamadas[0].auth, 'Bearer tok-secreto-123');
    assert.match(R.chamadas[0].url, /organization\/reports\?start_datetime=2026-09-01T00%3A00%3A00-03%3A00&end_datetime=2026-09-24T23%3A59%3A59-03%3A00&limit=500&page=1/);
    assert.match(R.chamadas[1].url, /page=2/);

    const vazio = respostas([{ status: 404, corpo: { message: 'Not Found' }, headers: { 'x-request-response-registers-found': '0' } }]);
    assert.deepEqual(await nextqs.senhas('2026-09-20', '2026-09-21', { fetch: vazio.fetch }), []);

    const negado = respostas([{ status: 401, corpo: { message: 'token tok-secreto-123 inválido' } }]);
    await assert.rejects(nextqs.senhas('2026-09-20', '2026-09-21', { fetch: negado.fetch, espera: 0 }), e => {
      assert.match(e.message, /recusou o token/);
      assert.ok(!e.message.includes('tok-secreto-123'));
      return true;
    });
    assert.equal(negado.chamadas.length, 1);          // 401 não tenta de novo

    const instavel = respostas([new Error('ECONNRESET'), { status: 503, corpo: {} }, { status: 200, corpo: [{ id: 1 }] }]);
    assert.equal((await nextqs.senhas('2026-09-20', '2026-09-21', { fetch: instavel.fetch, espera: 0 })).length, 1);
    assert.equal(instavel.chamadas.length, 3);

    delete process.env.NEXTQS_TOKEN;
    await assert.rejects(nextqs.senhas('2026-09-20', '2026-09-21', { fetch: R.fetch }), /NEXTQS_TOKEN não configurado/);
  } finally {
    if (antes === undefined) delete process.env.NEXTQS_TOKEN; else process.env.NEXTQS_TOKEN = antes;
  }
});

test('coleta: grava cada dia (upsert) e a situação; na falha, grava ultima e ultima_falha', async () => {
  const original = db.pool.query;
  const sql = [];
  db.pool.query = async (texto, params) => { sql.push({ texto, params }); return { rows: [] }; };
  try {
    const buscar = async (a, b) => { assert.deepEqual([a, b], ['2026-09-21', '2026-09-24']); return [senha({ ticket_generated_at: '2026-09-22T13:00:00Z', service_started_at: '2026-09-22T13:05:00Z', service_ended_at: '2026-09-22T13:15:00Z' })]; };
    const r = await A.coletar({ agora: AGORA, buscar });
    assert.equal(r.mensagem, 'Coleta concluída: 1 senha(s) em 4 dia(s).');
    const dias = sql.filter(x => /INSERT INTO atendimentos_dia/.test(x.texto));
    assert.deepEqual(dias.map(x => x.params[0]), ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24']);
    const st = sql.filter(x => /INSERT INTO atendimentos_status/.test(x.texto));
    assert.deepEqual(st.map(x => [x.params[0], x.params[1]]), [['ultima', true]]);

    sql.length = 0;
    await assert.rejects(A.coletar({ agora: AGORA, buscar: async () => { throw new Error('A API do NextQS não respondeu'); } }), /não respondeu/);
    const st2 = sql.filter(x => /INSERT INTO atendimentos_status/.test(x.texto));
    assert.deepEqual(st2.map(x => [x.params[0], x.params[1]]), [['ultima', false], ['ultima_falha', false]]);
  } finally {
    db.pool.query = original;
  }
});

test('PDF mensal: 2 folhas, PDF válido (xref aponta para os objetos), identidade e números', () => {
  const dados = (at, em) => ({ v: 1, r: [['Escrituras', 'Lara', 'Mesa 2', 'CN2O', em, at, em - at, 600 * em, em, 900 * at, at, 0, 0]], h: [['09h', em]] });
  const linhas = [
    { dia: '2026-08-10', dados: dados(10, 12) },
    { dia: '2026-09-01', dados: JSON.stringify(dados(20, 22)) },
    { dia: '2026-09-02', dados: dados(30, 31) }
  ];
  const g = montarPdf({ mes: '2026-09', linhas, agora: new Date('2026-10-01T10:00:00Z') });
  const s = g.pdf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  assert.equal((s.match(/\/Type \/Page\b/g) || []).length, 2);
  const xref = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.equal(s.slice(xref, xref + 4), 'xref');
  const offs = s.slice(xref).split('\n').filter(l => / 00000 n $/.test(l)).map(l => Number(l.slice(0, 10)));
  offs.forEach((o, i) => assert.equal(s.slice(o, o + String(i + 1).length + 6), `${i + 1} 0 obj`));
  assert.match(s, /Atendimentos de setembro de 2026/);
  assert.match(s, /coletada automaticamente pelo Hub CN2O/);
  assert.deepEqual(g.resumo, { mes: '2026-09', senhas: 53, atendidas: 50, nao_atendidas: 3, dias: 2, espera_media: 600, atendimento_medio: 900 });
  assert.match(g.nome, /2026-09 \(setembro de 2026\)\.pdf$/);
});

test('agenda: coleta seg–sex às 17h; PDF mensal às 7h do 1º dia útil', () => {
  const T = s => devidosAtendimentos(local(new Date(s + ':00-03:00'))).map(t => t.tarefa);
  assert.deepEqual(T('2026-09-24T16:59'), []);
  assert.deepEqual(T('2026-09-24T17:00'), ['atendimentos_coleta']);
  assert.deepEqual(T('2026-09-26T17:30'), []);                              // sábado
  assert.deepEqual(T('2026-10-01T06:59'), []);
  assert.deepEqual(T('2026-10-01T07:00'), ['atendimentos_mensal']);         // quinta, 1º dia útil
  assert.deepEqual(T('2026-10-01T17:00'), ['atendimentos_coleta', 'atendimentos_mensal']);
  assert.deepEqual(T('2026-11-02T08:00'), []);                              // Finados
  assert.deepEqual(T('2026-11-03T07:10'), ['atendimentos_mensal']);
});

test('e-mail: anexo binário (PDF) segue intacto em base64', async () => {
  const email = require('../relatorio-email');
  const guard = ['RELATORIO_EMAIL_PROVEDOR', 'RELATORIO_EMAIL_WEBAPP_URL', 'RELATORIO_EMAIL_SECRET'];
  const antes = Object.fromEntries(guard.map(k => [k, process.env[k]]));
  const fetchAntes = global.fetch;
  let corpo = null;
  try {
    delete process.env.RELATORIO_EMAIL_PROVEDOR;
    process.env.RELATORIO_EMAIL_WEBAPP_URL = 'https://script.exemplo/exec';
    process.env.RELATORIO_EMAIL_SECRET = 's';
    global.fetch = async (url, op) => { corpo = JSON.parse(op.body); return { ok: true, status: 200, text: async () => '{"ok":true}' }; };
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xe2, 0xe3, 0xcf, 0xd3, 0x00, 0xff]);
    await email.enviar({ para: ['a@b'], assunto: 'x', html: '<p>x</p>', texto: 'x', anexos: [{ nome: 'a.pdf', tipo: 'application/pdf', conteudo: bytes }, { nome: 'b.csv', tipo: 'text/csv', conteudo: 'ç;1' }] });
    assert.deepEqual(Buffer.from(corpo.anexos[0].base64, 'base64'), bytes);
    assert.equal(Buffer.from(corpo.anexos[1].base64, 'base64').toString('utf8'), 'ç;1');
  } finally {
    global.fetch = fetchAntes;
    for (const [k, v] of Object.entries(antes)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
