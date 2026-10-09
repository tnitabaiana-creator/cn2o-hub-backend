'use strict';
const express = require('express');
const native = require('./db');
const storage = require('./livro-caixa-db');
function createRouter({ pool = native.pool, session = native.sessaoValida, initialize = () => storage.init(pool) } = {}) {
  const router = express.Router();
  router.use(async (req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    try {
      const usuario = await session(req.get('X-Auth-Token') || '');
      if (!usuario) return res.status(401).json({ erro: 'sessão inválida ou expirada — entre de novo' });
      if (usuario.login !== 'cesar.bravo') return res.status(403).json({ erro: 'acesso restrito a César Bravo' });
      req.usuario = usuario; next();
    } catch { res.status(503).json({ erro: 'não foi possível confirmar a sessão' }); }
  });
  router.use(express.json({ limit: 14 * 1024 * 1024 }));
  const executar = fn => async (req, res) => {
    try { await initialize(); await fn(req, res); }
    catch (e) {
      if ([400, 403, 404, 409, 413].includes(e.status)) return res.status(e.status).json({ erro: e.message, codigo: e.codigo });
      console.error('livro-caixa: operação indisponível');
      res.status(503).json({ erro: 'não foi possível concluir a operação — o salvamento não foi confirmado', codigo: 'LIVRO_CAIXA_INDISPONIVEL' });
    }
  };
  router.get('/', executar(async (_, res) => res.json(await storage.listar(pool))));
  router.post('/meses/:mes', executar(async (req, res) => res.json(await storage.salvar(pool, req.params.mes, req.body, req.usuario.login))));
  router.get('/meses/:mes/historico', executar(async (req, res) => res.json(await storage.historico(pool, req.params.mes))));
  router.get('/anexos/:id', executar(async (req, res) => {
    const a = await storage.obterAnexo(pool, req.params.id);
    res.set({ 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Type': a.tipo });
    res.attachment(a.nome); res.send(a.bytes);
  }));
  router.use((e, req, res, next) => {
    if (e?.type === 'entity.too.large') return res.status(413).json({ erro: 'o anexo deve ter até 10 MiB', codigo: 'ANEXO_GRANDE' });
    if (e?.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido', codigo: 'PEDIDO_INVALIDO' });
    next(e);
  });
  return router;
}
module.exports = { createRouter };
