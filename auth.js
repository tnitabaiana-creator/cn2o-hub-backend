// auth.js — senhas (scrypt, nativo do Node) e tokens de sessão
const crypto = require('crypto');

function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(senha, salt, 64).toString('hex');
  return `${salt}:${h}`;
}

function verificaSenha(senha, armazenado) {
  const [salt, h] = String(armazenado).split(':');
  const c = crypto.scryptSync(senha, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(c, 'hex'));
}

const novoToken = () => crypto.randomBytes(32).toString('hex');

module.exports = { hashSenha, verificaSenha, novoToken };
