'use strict';
// v1.40.1 — economia: toda chamada ao Gemini vai para o modelo único (gemini-3.8-flash).
const test = require('node:test');
const assert = require('node:assert/strict');
const gemini = require('../gemini');

test('modelo único: pro, flash-lite ou agente do banco — tudo sai pelo gemini-3.8-flash', async () => {
  const antes = { fetch: global.fetch, chave: process.env.GEMINI_API_KEY };
  const urls = [];
  global.fetch = async url => {
    urls.push(String(url));
    return { ok: true, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }) };
  };
  process.env.GEMINI_API_KEY = 'teste';
  try {
    assert.equal(gemini.MODELO_UNICO, 'gemini-3.8-flash');
    assert.equal(gemini.MODELO_EXTRACAO, 'gemini-3.8-flash');
    const r = await gemini.executar({ agente: { prompt_sistema: 'x' }, observacoes: 'y', modelo: 'gemini-pro-latest' });
    assert.equal(r.uso.modelo, 'gemini-3.8-flash');                                   // o consumo registra o que respondeu
    await gemini.executar({ agente: { prompt_sistema: 'x', modelo_redacao: 'gemini-3.1-pro' }, observacoes: 'y' });
    await gemini.extrair({ agente: { prompt_sistema: 'x', modelo_extracao: 'gemini-3.5-flash-lite', campos: [] }, arquivos: [], observacoes: 'z' }).catch(() => {});
    assert.ok(urls.length >= 3);
    urls.forEach(u => assert.match(u, /\/models\/gemini-3\.8-flash:generateContent$/));
  } finally {
    global.fetch = antes.fetch;
    if (antes.chave === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = antes.chave;
  }
});
