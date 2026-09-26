// limites.js — freio contra força bruta no login e no primeiro acesso (v1.39.1).
//
// Conta falhas por chave numa janela de 15 min: por LOGIN (5 falhas → bloqueia aquele
// usuário por 15 min, venha de onde vier) e por IP (20 falhas → bloqueia aquele
// endereço, que tenta vários usuários). Acerto zera o contador do login. Em memória:
// o Hub roda numa instância só; um reinício zera os contadores (e o atacante perde o
// que acumulou do mesmo jeito que ganha — aceitável para 15 min de janela).
'use strict';

const JANELA_MS = 15 * 60e3;
const BLOQUEIO_MS = 15 * 60e3;
const MAXIMOS = { login: 5, ip: 20 };
const TETO_CHAVES = 5000;

const falhas = new Map();   // chave → { n, desde, ate }

function tipo(chave) { return String(chave).split(':')[0]; }
function atual(chave, agora) {
  const e = falhas.get(chave);
  if (!e) return null;
  if (e.ate && e.ate <= agora) { falhas.delete(chave); return null; }       // bloqueio vencido
  if (!e.ate && agora - e.desde > JANELA_MS) { falhas.delete(chave); return null; }   // janela vencida
  return e;
}

// segundos de bloqueio que ainda faltam (0 = liberado), olhando todas as chaves
function bloqueado(chaves, agora = Date.now()) {
  let resta = 0;
  for (const c of chaves) {
    const e = atual(c, agora);
    if (e && e.ate) resta = Math.max(resta, Math.ceil((e.ate - agora) / 1000));
  }
  return resta;
}

// registra uma falha; devolve true se alguma chave acabou de ser bloqueada
function falhou(chaves, agora = Date.now()) {
  let bloqueou = false;
  if (falhas.size > TETO_CHAVES) for (const k of falhas.keys()) { if (!atual(k, agora)) falhas.delete(k); }
  for (const c of chaves) {
    const e = atual(c, agora) || { n: 0, desde: agora, ate: 0 };
    e.n++;
    const max = MAXIMOS[tipo(c)] || MAXIMOS.login;
    if (!e.ate && e.n >= max) { e.ate = agora + BLOQUEIO_MS; bloqueou = true; }
    falhas.set(c, e);
  }
  return bloqueou;
}

function limpar(chave) { falhas.delete(chave); }
function zerarTudo() { falhas.clear(); }

module.exports = { bloqueado, falhou, limpar, zerarTudo, JANELA_MS, BLOQUEIO_MS, MAXIMOS };
