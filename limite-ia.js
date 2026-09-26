// limite-ia.js — freio de consumo das ferramentas de IA (v1.39.3, segurança · pacote C).
//
// Compartilhado pelo Hub (/hub/ia/*) e pela Plataforma de Agentes (/agentes/*):
//   • janela: no máximo HUB_IA_LIMITE análises por pessoa a cada 10 min (padrão 15;
//     antes 40, e a Plataforma de Agentes não tinha limite nenhum);
//   • teto diário: gasto estimado da pessoa no dia (tabela consumo, fuso de Sergipe) até
//     HUB_IA_TETO_DIA_USD (padrão US$ 5). Protege a conta do Google de uma sessão roubada
//     ou de um laço — o Tabelião aumenta pela variável se a rotina pedir mais.
'use strict';

const JANELA_MS = 10 * 60 * 1000;
const usoRecente = new Map();            // login → [instantes]

function limiteJanela() { return Number(process.env.HUB_IA_LIMITE) || 15; }
function tetoDia() { const v = Number(process.env.HUB_IA_TETO_DIA_USD); return v > 0 ? v : 5; }

// 0 = liberado; > 0 = segundos até liberar (e NÃO conta a tentativa)
function aguardarLimite(login, agora = Date.now()) {
  const max = limiteJanela();
  const lista = (usoRecente.get(login) || []).filter(t => agora - t < JANELA_MS);
  if (lista.length >= max) {
    usoRecente.set(login, lista);
    return Math.max(1, Math.ceil((JANELA_MS - (agora - lista[0])) / 1000));
  }
  lista.push(agora);
  usoRecente.set(login, lista);
  return 0;
}

// { excedido, gasto, teto } — gasto estimado do login desde a meia-noite de Sergipe
async function tetoDiario(login, q = (t, p) => require('./db').pool.query(t, p)) {
  const teto = tetoDia();
  const r = await q(
    `SELECT COALESCE(SUM(custo_usd), 0)::float AS gasto FROM consumo
      WHERE usuario = $1 AND criado >= (date_trunc('day', now() AT TIME ZONE 'America/Maceio') AT TIME ZONE 'America/Maceio')`,
    [login]);
  const gasto = Number((r.rows[0] || {}).gasto) || 0;
  return { excedido: gasto >= teto, gasto, teto };
}
const MSG_TETO = t => `o limite diário de uso da IA desta conta foi atingido (US$ ${t.gasto.toFixed(2)} de US$ ${t.teto.toFixed(2)}) — volta amanhã; se for preciso mais hoje, fale com o Tabelião`;

function zerar() { usoRecente.clear(); }

module.exports = { aguardarLimite, tetoDiario, MSG_TETO, limiteJanela, tetoDia, zerar, JANELA_MS };
