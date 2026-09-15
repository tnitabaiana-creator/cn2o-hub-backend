// docs.js — ponte Minuta → Google Docs (v1.29).
//
// Pedido do Tabelião: a minuta do Gerador nasce como Google Doc na pasta do
// Gerador (Drive dele), já com a formatação da casa, e o Hub mostra o link para
// a escrevente abrir. Quem formata é um Apps Script publicado como web app; este
// módulo só chama o web app e devolve a URL. Nada do Google entra aqui: sem
// biblioteca, sem OAuth — um POST com o segredo compartilhado, como o Apps Script
// espera.
//
// Variáveis (Railway):
//   HUB_DOCS_WEBAPP_URL  — URL do web app (…/exec). Sem ela, ativo() é false e o
//                          hub.js nem tenta: a resposta da minuta sai como sempre.
//   HUB_DOCS_SECRET      — segredo compartilhado com o Apps Script (vai no corpo,
//                          nunca na URL e nunca no log).
//   HUB_DOCS_TIMEOUT_MS  — espera máxima (padrão 40 s: o Apps Script cria o
//                          documento e formata antes de responder).
//
// Contrato com o web app (versao 1):
//   → POST, corpo JSON serializado, Content-Type text/plain;charset=utf-8. O
//     text/plain é de propósito: com application/json o navegador faria preflight
//     e o Apps Script não responde OPTIONS; aqui é servidor → servidor, mas o .gs
//     lê e.postData.contents do mesmo jeito, então o contrato é um só.
//     { segredo, versao: 1, titulo, ato, estado, minuta, anotacoes, escrevente,
//       modelo, protocolo, gerada_em }
//   ← o Apps Script responde o POST com 302 para script.googleusercontent.com e a
//     resposta final (GET) é JSON: { ok: true, id, url } ou { ok: false, erro }.
//     Por isso o fetch segue o redirecionamento (redirect: 'follow').
'use strict';

function ativo() {
  return !!(process.env.HUB_DOCS_WEBAPP_URL && process.env.HUB_DOCS_SECRET);
}

function texto(v) { return v == null ? '' : String(v); }

// Cria o documento e devolve { id, url, titulo }. Qualquer falha vira um Error
// com mensagem curta e legível ("Google Docs: …") — o hub.js a devolve como
// doc_erro sem derrubar a resposta da minuta.
async function criarMinuta({ titulo, ato, estado, minuta, anotacoes, escrevente, modelo, protocolo, gerada_em }) {
  if (!ativo()) throw new Error('Google Docs: integração não configurada (HUB_DOCS_WEBAPP_URL / HUB_DOCS_SECRET)');
  const corpo = JSON.stringify({
    segredo: process.env.HUB_DOCS_SECRET,
    versao: 1,
    titulo: texto(titulo),
    ato: texto(ato),
    estado: texto(estado),
    minuta: texto(minuta),
    anotacoes: texto(anotacoes),
    escrevente: texto(escrevente),
    modelo: texto(modelo),
    protocolo: texto(protocolo),
    gerada_em: texto(gerada_em)
  });
  const limite = Number(process.env.HUB_DOCS_TIMEOUT_MS) || 40000;
  let r;
  try {
    r = await fetch(process.env.HUB_DOCS_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: corpo,
      redirect: 'follow',
      signal: AbortSignal.timeout(limite)
    });
  } catch (e) {
    // Mensagens do fetch nunca levam o corpo (e portanto o segredo); ainda assim
    // só o essencial passa adiante — o balcão precisa saber que o Docs não
    // respondeu, não ler o erro de rede inteiro.
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error('Google Docs: o Apps Script não respondeu em ' + Math.max(1, Math.round(limite / 1000)) + ' s');
    }
    throw new Error('Google Docs: sem resposta do Apps Script (' + texto(e && e.message).slice(0, 120) + ')');
  }
  const bruto = await r.text();
  if (!r.ok) throw new Error('Google Docs: o Apps Script respondeu HTTP ' + r.status);
  let j = null;
  try { j = JSON.parse(bruto); } catch (_) { j = null; }
  if (!j || typeof j !== 'object') throw new Error('Google Docs: a resposta do Apps Script não é JSON');
  if (j.ok !== true) throw new Error('Google Docs: ' + (texto(j.erro).trim().slice(0, 200) || 'o Apps Script recusou o pedido'));
  const url = texto(j.url).trim();
  if (!/^https:\/\//.test(url)) throw new Error('Google Docs: o Apps Script não devolveu a URL do documento');
  return { id: texto(j.id).trim(), url, titulo: texto(titulo) };
}

module.exports = { ativo, criarMinuta };
