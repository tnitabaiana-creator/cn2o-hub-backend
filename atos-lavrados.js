'use strict';
const express = require('express');
const db = require('./db');
const store = require('./atos-lavrados-db');
function createRouter({ pool = db.pool, session = db.sessaoValida, ehAdmin = () => false } = {}) {
  const r = express.Router();
  r.use(async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store'); res.set('X-Content-Type-Options', 'nosniff');
    try {
      const u = await session(req.get('X-Auth-Token') || '');
      if (!u) return res.status(401).json({ erro: 'sessão inválida ou expirada' });
      if (!ehAdmin(u)) return res.status(403).json({ erro: 'acesso restrito ao administrador' });
      req.usuario = u; next();
    } catch { res.status(503).json({ erro: 'não foi possível confirmar a sessão' }); }
  });
  r.use(express.json({ limit: store.MAX_BYTES }));
  const executar = f => async (req, res) => {
    try { res.json(await f(req)); }
    catch (e) {
      if ([400, 404, 409, 413, 422].includes(e.status)) return res.status(e.status).json({ erro: e.message, codigo: e.codigo, ...(e.codigo === 'PENDENTE_SEM_ATRIBUICAO' ? { pendencias: e.pendencias } : {}) });
      console.error('atos lavrados: operação indisponível');
      res.status(503).json({ erro: 'não foi possível concluir a operação; nenhum novo salvamento foi confirmado', codigo: 'FONTE_INDISPONIVEL' });
    }
  };
  r.get('/meses', executar(() => store.meses(pool)));
  r.get('/resumo', executar(req => store.resumo(pool, req.query.inicio, req.query.fim, true)));
  r.get('/semana', executar(req => store.semana(pool, req.query.referencia)));
  r.get('/atos', executar(req => store.atos(pool, req.query.inicio, req.query.fim, req.query.pagina === undefined ? 1 : Number(req.query.pagina))));
  r.get('/meses/:mes/versoes', executar(async req => ({ versoes: await store.versoes(pool, req.params.mes) })));
  r.get('/lotes/:id/backup', executar(req => store.backup(pool, req.params.id)));
  r.post('/lotes/validar', executar(req => store.importar(pool, req.body, req.usuario.login, true)));
  r.post('/lotes', executar(req => store.importar(pool, req.body, req.usuario.login)));
  r.post('/vinculos', executar(req => store.vincular(pool, req.body, req.usuario.login)));
  r.post('/autorias', executar(req => store.atribuirAutoria(pool, req.body, req.usuario.login)));
  r.get('/autorias/:chave/historico', executar(async req => ({ historico: await store.historicoAutoria(pool, req.params.chave) })));
  r.use((e, req, res, next) => {
    if (e?.type === 'entity.too.large') return res.status(413).json({ erro: 'lote maior que 20 MiB', codigo: 'LOTE_GRANDE' });
    if (e?.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido', codigo: 'LOTE_INVALIDO' });
    next(e);
  });
  return r;
}
module.exports = { createRouter };
