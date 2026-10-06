'use strict';
const crypto = require('crypto');
const f = require('./protocolo-fonte');
// Credencial dedicada somente a esta leitura, nunca aceita por rotas de escrita.
function autorizado(header, segredo) {
  if (!/^[a-f0-9]{64}$/i.test(String(segredo || ''))) return false;
  const m = /^Bearer ([a-f0-9]{64})$/i.exec(String(header || ''));
  if (!m) return false;
  return crypto.timingSafeEqual(Buffer.from(m[1], 'hex'), Buffer.from(segredo, 'hex'));
}
function handler({ query, segredo = () => process.env.HUB_FONTE_SERVICE_TOKEN }) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!autorizado(req.headers?.authorization, segredo())) return res.status(401).json({ erro: 'Acesso de integração não autorizado.' });
    if (!/^[a-f0-9]{24}$/i.test(String(req.params.cardId || ''))) return res.status(400).json({ erro: 'Identificador de cartão inválido.' });
    try {
      const r = await query('SELECT numero, dados, card_id, usuario, criado_em FROM protocolos WHERE card_id=$1 LIMIT 2', [req.params.cardId]);
      if (!r.rows.length) return res.status(404).json({ codigo: 'PROTOCOLO_NAO_ENCONTRADO', erro: 'Protocolo não localizado para este cartão.' });
      if (r.rows.length !== 1) return res.status(409).json({ erro: 'Cartão vinculado a mais de um protocolo; exige conferência humana.' });
      const body = { fonte: f.criarFonte(r.rows[0]) };
      if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 1024 * 1024) return res.status(413).json({ erro: 'Fonte excede o limite de leitura; exige conferência humana.' });
      res.json(body);
    } catch (_) { res.status(503).json({ erro: 'Fonte indisponível; não utilizar cópia antiga como fonte atual.' }); }
  };
}
module.exports = { autorizado, handler };
