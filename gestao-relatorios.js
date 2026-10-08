'use strict';
const express = require('express');
const native = require('./db');
const storage = require('./gestao-relatorios-db');
function createRouter({ pool = native.pool, session = native.sessaoValida, ehAdmin = () => false,
  initialize = () => storage.init(pool), auditar = () => {} } = {}) {
  const router = express.Router();
  router.use(async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    try {
      const usuario = await session(req.get('X-Auth-Token') || '');
      if (!usuario) return res.status(401).json({ erro: 'sessão inválida ou expirada — entre de novo' });
      if (!ehAdmin(usuario)) return res.status(403).json({ erro: 'acesso restrito ao Tabelião' });
      req.usuario = usuario; next();
    } catch { res.status(503).json({ erro: 'não foi possível confirmar a sessão' }); }
  });
  // A autenticação vem antes de consumir o corpo; somente JSON é exposto ao Hub.
  router.use(express.json({ limit: storage.MAX_BYTES + 4096 }));
  const executar = fn => async (req, res) => {
    try { await initialize(); await fn(req, res); }
    catch (e) {
      if ([400, 404, 409, 413].includes(e.status)) return res.status(e.status).json({ erro: e.message, codigo: e.codigo });
      console.error('gestão de relatórios: operação indisponível');
      res.status(503).json({ erro: 'não foi possível concluir a operação — o salvamento não foi confirmado', codigo: 'RELATORIO_INDISPONIVEL' });
    }
  };
  router.get('/produtividade-escrituras', executar(async (req, res) => res.json(await storage.obter(pool))));
  router.post('/produtividade-escrituras/estado', executar(async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(k => !['meses', 'revisao'].includes(k))) {
      throw storage.erro(400, 'PEDIDO_INVALIDO', 'informe somente meses e revisão');
    }
    const salvo = await storage.salvar(pool, req.body, req.usuario.login);
    try { auditar(req, 'gestao', 'salvar-produtividade', ''); } catch {}
    res.json(salvo);
  }));
  router.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ erro: 'os dados devem ter até 2 MiB', codigo: 'ESTADO_GRANDE' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido', codigo: 'PEDIDO_INVALIDO' });
    next(err);
  });
  return router;
}
module.exports = { createRouter };
