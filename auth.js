// auth.js — senhas (scrypt, nativo do Node), tokens de sessão e códigos de primeiro acesso
//
// v1.39.1 (segurança, pacote A):
//   • scrypt ASSÍNCRONO (antes scryptSync travava o processo a cada login) e com os
//     parâmetros da OWASP (N=2^14, r=8, p=5 ≈ 16 MiB). Formato novo "s2$N$r$p$sal$hash";
//     o antigo "sal:hash" (N=2^14, r=8, p=1) continua valendo e é regravado no formato
//     novo no próximo login certo (verificaSenha devolve atualizar: true).
//   • o token da sessão vai ao navegador; no banco fica só o SHA-256 dele (hashToken).
//   • código de primeiro acesso: 10 caracteres sem letras ambíguas (≈ 50 bits), de uso
//     único e com validade, gerado pelo Tabelião e entregue em mãos. No banco, só o hash.
'use strict';
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const ATUAL = { N: 16384, r: 8, p: 5 };
const ANTIGO = { N: 16384, r: 8, p: 1 };
const MAXMEM = 64 * 1024 * 1024;
const TAM = 64;
const MAX_SENHA = 200;          // teto do que se passa ao scrypt (senha gigante = CPU gasta à toa)

async function derivar(senha, sal, p) {
  return scrypt(String(senha).slice(0, MAX_SENHA), sal, TAM, { N: p.N, r: p.r, p: p.p, maxmem: MAXMEM });
}

async function hashSenha(senha) {
  const sal = crypto.randomBytes(16).toString('hex');
  const h = await derivar(senha, sal, ATUAL);
  return `s2$${ATUAL.N}$${ATUAL.r}$${ATUAL.p}$${sal}$${h.toString('hex')}`;
}

// { ok, atualizar } — atualizar = true quando o hash está no formato antigo
async function verificaSenha(senha, armazenado) {
  const s = String(armazenado || '');
  let p, sal, h, antigo = false;
  if (s.startsWith('s2$')) {
    const x = s.split('$');
    p = { N: Number(x[1]), r: Number(x[2]), p: Number(x[3]) }; sal = x[4]; h = x[5];
  } else {
    [sal, h] = s.split(':'); p = ANTIGO; antigo = true;
  }
  if (!sal || !h || !/^[0-9a-f]+$/i.test(h) || !(p.N > 1 && p.r > 0 && p.p > 0)) {
    await derivar(senha || '', 'x'.repeat(32), ATUAL);    // mesmo custo de tempo, resposta igual
    return { ok: false, atualizar: false };
  }
  const esperado = Buffer.from(h, 'hex');
  const calculado = await derivar(senha || '', sal, p);
  const ok = esperado.length === calculado.length && crypto.timingSafeEqual(esperado, calculado);
  const formatoVelho = antigo || p.N !== ATUAL.N || p.r !== ATUAL.r || p.p !== ATUAL.p;
  return { ok, atualizar: ok && formatoVelho };
}

// Para usuário inexistente ou sem senha: gasta o mesmo tempo de uma verificação real,
// para o tempo de resposta não revelar quem existe.
const HASH_FALSO = `s2$${ATUAL.N}$${ATUAL.r}$${ATUAL.p}$${'0'.repeat(32)}$${'0'.repeat(TAM * 2)}`;

const novoToken = () => crypto.randomBytes(32).toString('hex');
const hashToken = token => crypto.createHash('sha256').update(String(token || '')).digest('hex');

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sem I, O, 0 e 1
function novoCodigo() {
  const b = crypto.randomBytes(10);
  let c = '';
  for (let i = 0; i < 10; i++) c += ALFABETO[b[i] % ALFABETO.length];   // 256 % 32 = 0: sem viés
  return c.slice(0, 5) + '-' + c.slice(5);
}
const normalizarCodigo = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 40);
const hashCodigo = c => crypto.createHash('sha256').update('cn2o-codigo:' + normalizarCodigo(c)).digest('hex');

// comparação de segredos em tempo constante (para chaves de ambiente)
function segredoIgual(a, b) {
  const x = crypto.createHash('sha256').update(String(a || '')).digest();
  const y = crypto.createHash('sha256').update(String(b || '')).digest();
  return crypto.timingSafeEqual(x, y) && String(b || '').length > 0;
}

module.exports = {
  hashSenha, verificaSenha, HASH_FALSO, novoToken, hashToken, novoCodigo, normalizarCodigo, hashCodigo,
  segredoIgual, MAX_SENHA
};
