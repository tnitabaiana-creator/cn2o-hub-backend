'use strict';
const express = require('express');
const { createHash } = require('node:crypto');
const native = require('./db');
const storage = require('./itcmd-arquivo-db');
const MAX_ESTADO = 1024 * 1024;
const MAX_PDF = 5 * 1024 * 1024;
const MAX_TOTAL = 15 * 1024 * 1024;
const TIPOS = new Set(['orcamento', 'declaracao_causa_mortis', 'declaracao_inter_vivos', 'guia_itcmd']);
const MODOS = new Set(['inventario', 'cumulativo', 'doacao']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const falha = (mensagem, status = 400, codigo = 'PEDIDO_INVALIDO') => storage.erro(status, codigo, mensagem);
const hash = b => createHash('sha256').update(b).digest('hex');
function uuid(v) {
  if (typeof v !== 'string' || !UUID.test(v)) throw falha('identificador inválido');
  return v.toLowerCase();
}
function texto(v, limite, obrigatorio = true) {
  if (v == null && !obrigatorio) return '';
  if (typeof v !== 'string' || /[\u0000-\u001f\u007f]/.test(v) || Buffer.from(v, 'utf8').toString('utf8') !== v) throw falha('texto inválido');
  const r = v.trim();
  if ((obrigatorio && !r) || r.length > limite) throw falha('texto vazio ou maior que o limite de ' + limite + ' caracteres');
  return r;
}
function validarEstado(estado) {
  if (!estado || typeof estado !== 'object' || Array.isArray(estado)) throw falha('informe os dados da calculadora para salvar o trabalho');
  let serializado;
  try { serializado = JSON.stringify(estado); } catch { throw falha('dados da calculadora inválidos'); }
  if (Buffer.byteLength(serializado, 'utf8') > MAX_ESTADO) throw falha('dados da calculadora excedem o limite de 1 MB', 413);
  let total = 0;
  const vistos = new WeakSet();
  function conferir(v, profundidade) {
    if (++total > 50000 || profundidade > 24) throw falha('estrutura dos dados da calculadora muito extensa');
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'string') {
      if (v.includes('\0') || Buffer.from(v, 'utf8').toString('utf8') !== v) throw falha('texto inválido nos dados da calculadora');
      return;
    }
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v !== 'object' || vistos.has(v)) throw falha('dados da calculadora inválidos');
    vistos.add(v);
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw falha('objeto inválido nos dados da calculadora');
    for (const k of Object.keys(v)) {
      if (['__proto__', 'prototype', 'constructor'].includes(k) || k.includes('\0') || Buffer.from(k, 'utf8').toString('utf8') !== k) throw falha('campo não permitido nos dados da calculadora');
      conferir(v[k], profundidade + 1);
    }
  }
  conferir(estado, 0);
  if (!MODOS.has(estado.modo)) throw falha('modo da calculadora inválido');
  if (estado.modo === 'doacao') {
    if (!estado.doa || typeof estado.doa !== 'object' || Array.isArray(estado.doa)) throw falha('dados da doação ausentes');
  } else if (!Array.isArray(estado.inv) || estado.inv.length === 0) throw falha('dados do inventário ausentes');
  return estado;
}
function validarPDF(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d) || !TIPOS.has(d.tipo) || d.mime !== 'application/pdf') throw falha('tipo de documento inválido — anexe um PDF do orçamento, declaração ou guia');
  if (Object.hasOwn(d, 'url')) throw falha('envie o arquivo PDF, não um endereço externo');
  let nome = texto(d.nome, 180).replace(/[\\/:*?"<>|]/g, '_');
  if (!/\.pdf$/i.test(nome)) nome += '.pdf';
  const b64 = d.base64;
  if (typeof b64 !== 'string' || !b64.length || b64.length % 4 !== 0) throw falha('PDF inválido ou incompleto');
  if (b64.length > Math.ceil(MAX_PDF / 3) * 4) throw falha('cada PDF deve ter até 5 MB', 413);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw falha('PDF inválido ou incompleto');
  const dados = Buffer.from(b64, 'base64');
  if (dados.length > MAX_PDF) throw falha('cada PDF deve ter até 5 MB', 413);
  if (dados.toString('base64') !== b64 || !/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(dados.toString('latin1', 0, 12))) throw falha('PDF inválido ou incompleto');
  const rodape = dados.toString('latin1', Math.max(0, dados.length - 2048));
  const fim = rodape.match(/startxref\s+(\d+)\s+%%EOF[\t\r\n ]*$/);
  if (!fim || Number(fim[1]) < 9 || Number(fim[1]) >= dados.length || !/\b\d+\s+\d+\s+obj\b/.test(dados.toString('latin1', 0, Math.min(dados.length, 65536)))) throw falha('PDF inválido ou incompleto');
  return { tipo: d.tipo, nome, mime: d.mime, dados, sha256: hash(dados) };
}
function canonico(v) {
  if (Array.isArray(v)) return '[' + v.map(canonico).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonico(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function validarPedido(corpo) {
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) throw falha('pedido inválido');
  const id = corpo.id == null ? null : uuid(corpo.id), operacao_id = uuid(corpo.operacao_id);
  if (!Number.isSafeInteger(corpo.versao_base) || corpo.versao_base < 0 || corpo.versao_base >= 2147483647 || (!id && corpo.versao_base !== 0)) throw falha('versão-base inválida');
  const titulo = texto(corpo.titulo, 160), protocolo = texto(corpo.protocolo, 40, false);
  const estado = validarEstado(corpo.estado);
  if (!Array.isArray(corpo.documentos) || corpo.documentos.length > 4) throw falha('envie até quatro PDFs por salvamento');
  const documentos = corpo.documentos.map(validarPDF);
  if (documentos.reduce((n, d) => n + d.dados.length, 0) > MAX_TOTAL) throw falha('os PDFs juntos devem ter até 15 MB', 413);
  const identidade = { id, titulo, protocolo, estado, versao_base: corpo.versao_base,
    documentos: documentos.map(({ dados, ...d }) => ({ ...d, bytes: dados.length })) };
  return { ...identidade, documentos, operacao_id, sha256: hash(canonico(identidade)) };
}
function adminPadrao(usuario) {
  const logins = (process.env.HUB_ADMINS || 'cesar.bravo').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return !!usuario && logins.includes(String(usuario.login || '').toLowerCase());
}
function createRouter({ pool = native.pool, session = native.sessaoValida, initialize = () => storage.init(pool), ehAdmin = adminPadrao, auditar = () => {} } = {}) {
  const router = express.Router();
  router.use(async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    try {
      const usuario = await session(req.get('X-Auth-Token') || '');
      if (!usuario) return res.status(401).json({ erro: 'sessão inválida ou expirada — entre de novo' });
      req.usuario = usuario;
      req.itcmdAdmin = !!ehAdmin(usuario);
      next();
    } catch { res.status(503).json({ erro: 'não foi possível confirmar a sessão' }); }
  });
  router.use(express.json({ limit: '24mb' }));
  const executar = handler => async (req, res) => {
    try { await initialize(); await handler(req, res); }
    catch (e) {
      if ([400, 404, 409, 413].includes(e.status)) return res.status(e.status).json({ erro: e.message, codigo: e.codigo });
      // Nunca registra estado, nomes, documentos ou mensagens SQL que os contenham.
      console.error('arquivo ITCMD: operação indisponível');
      res.status(503).json({ erro: 'não foi possível concluir a operação — o salvamento não foi confirmado', codigo: 'ARQUIVO_INDISPONIVEL' });
    }
  };
  router.post('/trabalhos', executar(async (req, res) => {
    const pedido = validarPedido(req.body);
    const salvo = await storage.salvar(pool, req.usuario, req.itcmdAdmin, pedido);
    try { auditar(req, 'itcmd', 'salvar-trabalho', ''); } catch {}
    res.json(salvo);
  }));
  router.get('/trabalhos', executar(async (req, res) => {
    const busca = req.query.busca === undefined ? '' : texto(req.query.busca, 160, false);
    const numero = req.query.pagina === undefined ? '1' : req.query.pagina;
    if (typeof numero !== 'string' || !/^[1-9]\d{0,5}$/.test(numero)) throw falha('página inválida');
    const grupo = req.query.grupo;
    if (grupo !== undefined && grupo !== 'inventario' && grupo !== 'doacao') throw falha('grupo inválido');
    res.json(await storage.listar(pool, req.usuario, req.itcmdAdmin, { busca, pagina: Number(numero), grupo }));
  }));
  router.get('/trabalhos/:id', executar(async (req, res) => {
    res.json(await storage.obter(pool, req.usuario, req.itcmdAdmin, uuid(req.params.id)));
  }));
  router.get('/trabalhos/:id/versoes/:versao', executar(async (req, res) => {
    if (!/^[1-9]\d{0,9}$/.test(req.params.versao) || Number(req.params.versao) > 2147483647) throw falha('versão inválida');
    res.json(await storage.obter(pool, req.usuario, req.itcmdAdmin, uuid(req.params.id), Number(req.params.versao)));
  }));
  router.get('/documentos/:id', executar(async (req, res) => {
    const d = await storage.documento(pool, req.usuario, req.itcmdAdmin, uuid(req.params.id));
    const ascii = d.nome.replace(/[^\x20-\x7e]|["\\]/g, '_');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(d.nome).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()));
    res.set('Content-Security-Policy', "sandbox; default-src 'none'");
    res.send(d.dados);
  }));
  router.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ erro: 'pedido grande demais — use até 5 MB por PDF e 15 MB no conjunto', codigo: 'PEDIDO_GRANDE' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido', codigo: 'PEDIDO_INVALIDO' });
    next(err);
  });
  return router;
}
module.exports = { router: createRouter(), createRouter, validarPedido, validarEstado, validarPDF, MAX_ESTADO, MAX_PDF, MAX_TOTAL };
