// acesso.js — entrar, primeiro acesso e sair (v1.39.1, segurança · pacote A).
//
// Antes: o /login dizia "primeiro_acesso" para quem estava sem senha, e o /definir-senha
// aceitava SÓ o login — qualquer pessoa na internet criava a senha de uma conta ainda
// sem senha (inclusive a do Tabelião) e entrava com ela. Agora:
//   • o primeiro acesso exige o código de uso único que o Tabelião gera na aba Equipe
//     (cadastro ou "gerar código"), entregue em mãos, válido por 48 h (db.gravarCodigo);
//   • o /login responde igual para usuário inexistente, sem senha ou senha errada, e
//     gasta o mesmo tempo nos três casos (HASH_FALSO);
//   • 5 falhas por login ou 20 por IP em 15 min → 15 min de bloqueio (limites.js),
//     com cada falha na trilha de auditoria (ação "acesso");
//   • emergência (o próprio Tabelião sem acesso): HUB_CODIGO_ADMIN na Railway, com pelo
//     menos 16 caracteres, vale como código só para os logins de HUB_ADMINS — e redefine
//     a senha deles. Apague a variável depois de usar.
'use strict';

const express = require('express');
const db = require('./db');
const auth = require('./auth');
const limites = require('./limites');

const router = express.Router();
const json = express.json({ limit: '8kb' });
const normLogin = v => String(v || '').trim().toLowerCase().slice(0, 60);
const admins = () => String(process.env.HUB_ADMINS || 'cesar.bravo').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const MSG_LOGIN = 'usuário ou senha inválidos';
const MSG_CODIGO = 'código inválido, vencido ou já usado — peça um novo ao Tabelião';

function auditar(req, login, ferramenta, detalhe) {
  try {
    req.usuario = req.usuario || { login };
    require('./hub').auditar(req, 'acesso', ferramenta, detalhe || '');
  } catch (e) { /* a trilha nunca derruba o acesso */ }
}
function chaves(req, login) { return ['login:' + login, 'ip:' + (req.ip || '')]; }
function barrado(req, res, login) {
  const resta = limites.bloqueado(chaves(req, login));
  if (!resta) return false;
  res.set('Retry-After', String(resta));
  res.status(429).json({ erro: `muitas tentativas — espere ${Math.ceil(resta / 60)} min e tente de novo` });
  return true;
}
function falha(req, login, ferramenta) {
  const bloqueou = limites.falhou(chaves(req, login));
  auditar(req, login, ferramenta, bloqueou ? 'bloqueio de 15 min' : '');
}
async function abrirSessao(res, u) {
  const token = auth.novoToken();
  await db.criarSessao(token, u.login);
  res.json({ token, nome: u.nome, cargo: u.cargo });
}

router.post('/login', json, async (req, res) => {
  const login = normLogin((req.body || {}).login);
  const senha = String((req.body || {}).senha || '');
  if (barrado(req, res, login)) return;
  try {
    const u = login ? await db.buscarUsuario(login) : null;
    const v = await auth.verificaSenha(senha, (u && u.senha_hash) || auth.HASH_FALSO);
    if (!u || !u.senha_hash || !senha || !v.ok) {
      falha(req, login, 'login-falha');
      return res.status(401).json({ erro: MSG_LOGIN });
    }
    limites.limpar('login:' + login);
    if (v.atualizar) await db.gravarSenha(u.login, await auth.hashSenha(senha));   // migra o hash antigo
    await abrirSessao(res, u);
  } catch (e) {
    console.error('login:', e.message);
    res.status(500).json({ erro: 'falha ao entrar — tente de novo' });
  }
});

router.post('/definir-senha', json, async (req, res) => {
  const b = req.body || {};
  const login = normLogin(b.login);
  const codigo = String(b.codigo || '');
  const senha = String(b.senha || '');
  if (barrado(req, res, login)) return;
  if (senha.length < 8) return res.status(400).json({ erro: 'a senha deve ter no mínimo 8 caracteres' });
  if (senha.length > auth.MAX_SENHA) return res.status(400).json({ erro: 'senha longa demais' });
  if (login && senha.toLowerCase().includes(login.split('.')[0])) {
    return res.status(400).json({ erro: 'a senha não pode conter o seu nome de usuário' });
  }
  try {
    // emergência: HUB_CODIGO_ADMIN (≥ 16 caracteres) vale só para os administradores
    const emerg = String(process.env.HUB_CODIGO_ADMIN || '').trim();
    if (emerg.length >= 16 && admins().includes(login) && auth.segredoIgual(auth.normalizarCodigo(codigo), auth.normalizarCodigo(emerg))) {
      const u = await db.buscarUsuario(login);
      if (u) {
        await db.gravarSenha(u.login, await auth.hashSenha(senha));
        await db.encerrarSessoesDe(u.login);
        limites.limpar('login:' + login);
        auditar(req, login, 'senha-emergencia', 'senha redefinida com HUB_CODIGO_ADMIN — apague a variável');
        console.warn(`acesso: senha de ${u.login} redefinida pelo código de emergência (HUB_CODIGO_ADMIN)`);
        return abrirSessao(res, u);
      }
    }
    const u = login && codigo ? await db.definirSenhaComCodigo(login, auth.hashCodigo(codigo), await auth.hashSenha(senha)) : null;
    if (!u) {
      falha(req, login, 'codigo-falha');
      return res.status(401).json({ erro: MSG_CODIGO });
    }
    limites.limpar('login:' + login);
    auditar(req, login, 'primeiro-acesso', 'senha criada com o código do Tabelião');
    await abrirSessao(res, u);
  } catch (e) {
    console.error('definir-senha:', e.message);
    res.status(500).json({ erro: 'falha ao criar a senha — tente de novo' });
  }
});

router.post('/logout', async (req, res) => {
  const t = req.get('X-Auth-Token');
  if (t) await db.encerrarSessao(t).catch(() => {});
  res.json({ ok: true });
});

module.exports = { router, MSG_LOGIN, MSG_CODIGO };
