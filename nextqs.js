// nextqs.js — cliente da API do NextQS (senhas e atendimentos do balcão), v1.39.
//
// Uma rota só: GET /v1/organization/reports?start_datetime&end_datetime&limit&page, com o
// token do Next Manager → API no cabeçalho (Bearer). Devolve uma lista de senhas; o total
// de páginas vem nos cabeçalhos x-request-response-*. O NextQS responde 404 "Not Found"
// quando o período não tem nenhuma senha — isso é "zero", não erro. A API aceita cerca de
// 92 dias por pedido: quem chama divide em janelas (JANELA_DIAS).
//
//   NEXTQS_TOKEN     obrigatória — o mesmo token que o n8n usava (credencial "NextQS API")
//   NEXTQS_API_URL   opcional (padrão https://api.nextqs.com/v1)
//
// O token nunca sai em log nem em mensagem de erro.
'use strict';

const BASE = 'https://api.nextqs.com/v1';
const POR_PAGINA = 500;
const MAX_PAGINAS = 60;          // 30 mil senhas por janela — sobra para o balcão do cartório
const JANELA_DIAS = 90;
const TENTATIVAS = 3;

const token = () => String(process.env.NEXTQS_TOKEN || '').trim();
const configurado = () => !!token();
const dormir = ms => new Promise(r => setTimeout(r, ms));

// Mensagem para gente, a partir do status HTTP ou do erro de rede.
function erroClaro(status, detalhe) {
  const d = String(detalhe || '').split(token()).join('***').slice(0, 200);
  let msg;
  if (status === 401 || status === 403) msg = 'O NextQS recusou o token da API (NEXTQS_TOKEN)';
  else if (status === 429) msg = 'Limite de consultas da API do NextQS atingido; a próxima coleta tenta de novo';
  else if (status >= 500 || !status) msg = 'A API do NextQS não respondeu; a próxima coleta tenta de novo';
  else msg = `A API do NextQS respondeu com erro ${status}`;
  return Object.assign(new Error(d ? `${msg} (${d})` : msg), { status: status || 0 });
}

// Uma página, com novas tentativas para rede, 429 e 5xx (como o n8n: 3 × 5 s).
async function pagina(url, { fetch = globalThis.fetch, espera = 5000 } = {}) {
  let ultimo;
  for (let t = 1; t <= TENTATIVAS; t++) {
    try {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token()}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(60000)
      });
      if (r.status === 404 && String(r.headers.get('x-request-response-registers-found') || '0') === '0') {
        return { senhas: [], fim: true };
      }
      if (r.ok) {
        const corpo = await r.json();
        const senhas = Array.isArray(corpo) ? corpo : [];
        const atual = Number(r.headers.get('x-request-response-current-page') || 0);
        const total = Number(r.headers.get('x-request-response-total-pages') || 0);
        return { senhas, fim: senhas.length < POR_PAGINA || (total > 0 && atual >= total) };
      }
      ultimo = erroClaro(r.status, await r.text().catch(() => ''));
      if (r.status !== 429 && r.status < 500) throw ultimo;       // 4xx: tentar de novo não resolve
    } catch (e) {
      if (e.status && e.status !== 429 && e.status < 500) throw e;
      ultimo = e.status !== undefined ? e : erroClaro(0, e.message);
    }
    if (t < TENTATIVAS) await dormir(espera);
  }
  throw ultimo;
}

// Todas as senhas emitidas entre inicio e fim (AAAA-MM-DD, horário de Sergipe), inclusive.
async function senhas(inicio, fim, opcoes = {}) {
  if (!configurado()) throw new Error('NEXTQS_TOKEN não configurado no servidor');
  const base = String(process.env.NEXTQS_API_URL || BASE).trim().replace(/\/+$/, '');
  const todas = [];
  for (let p = 1; p <= MAX_PAGINAS; p++) {
    const qs = new URLSearchParams({
      start_datetime: `${inicio}T00:00:00-03:00`, end_datetime: `${fim}T23:59:59-03:00`,
      limit: String(POR_PAGINA), page: String(p)
    });
    const r = await pagina(`${base}/organization/reports?${qs}`, opcoes);
    todas.push(...r.senhas);
    if (r.fim) break;
    await dormir(opcoes.intervalo === undefined ? 300 : opcoes.intervalo);
  }
  return todas;
}

module.exports = { senhas, configurado, erroClaro, POR_PAGINA, JANELA_DIAS };
