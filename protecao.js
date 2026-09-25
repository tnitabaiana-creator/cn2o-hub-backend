// protecao.js — defesas de borda do servidor (v1.39.2, segurança · pacote B).
//
//   cabecalhos        nosniff, sem iframe, sem Referer, HSTS e uma CSP para a única página
//                     servida aqui (Hub de Agentes, public/index.html)
//   cors(origens)     só o site do Hub (antes: "*"); pedidos sem Origin (Trello, n8n) seguem
//   tratadorDeErros   resposta genérica para o que escapou das rotas (sem pilha, sem detalhe)
//   mascaraTel        telefone de cliente com só os 4 últimos dígitos
//   podeReidratar     a re-hidratação do webhook do Trello escreve no Trello: só com
//                     assinatura válida (ou, sem TRELLO_SECRET, só nos quadros da casa)
'use strict';

const CSP_SERVIDOR = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:", "connect-src 'self'", "frame-src 'self' blob:", "object-src 'none'",
  "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"
].join('; ');

function cabecalhos(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.set('Content-Security-Policy', CSP_SERVIDOR);
  next();
}

function origensPermitidas(valor = process.env.CORS_ORIGENS) {
  return String(valor || 'https://cn2o-hub.netlify.app').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
}
function cors(origens = origensPermitidas()) {
  return (req, res, next) => {
    const origem = req.get('Origin');
    if (origem && origens.includes(origem)) {
      res.set('Access-Control-Allow-Origin', origem);
      res.set('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Max-Age', '600');
    }
    res.vary('Origin');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

// eslint-disable-next-line no-unused-vars
function tratadorDeErros(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = Number(err && (err.status || err.statusCode)) || 500;
  if (status >= 500) console.error('erro não tratado:', req.method, req.path, err && err.message);
  const cliente = status >= 400 && status < 500;
  res.status(cliente ? status : 500).json({
    erro: status === 413 ? 'arquivo grande demais' : cliente ? 'requisição inválida' : 'falha interna — tente de novo'
  });
}

function mascaraTel(t) {
  const d = String(t || '').replace(/\D/g, '');
  return d.length > 4 ? '•'.repeat(d.length - 4) + d.slice(-4) : (d ? '••••' : '');
}

function podeReidratar(assinatura, boardId, quadrosDaCasa) {
  if (assinatura === 'ok') return true;
  return assinatura === 'sem-segredo' && !!boardId && quadrosDaCasa.includes(boardId);
}

module.exports = { cabecalhos, cors, origensPermitidas, tratadorDeErros, mascaraTel, podeReidratar, CSP_SERVIDOR };
