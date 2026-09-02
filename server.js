// server.js — Hub de Protocolo CN2O
const express = require('express');
const db = require('./db');
const trello = require('./trello');
const { dispararRecibos } = require('./whats');
const { hashSenha, verificaSenha, novoToken } = require('./auth');

const app = express();
app.use(express.json({ limit: '256kb' }));

// CORS: o formulário roda no Netlify
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Hub-Key');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- autenticação individual (nome.sobrenome + senha própria) ----------
app.post('/login', async (req, res) => {
  try {
    const { login, senha } = req.body || {};
    const u = await db.buscarUsuario(login);
    if (!u) return res.status(401).json({ erro: 'usuário ou senha inválidos' });
    if (!u.senha_hash) return res.json({ primeiro_acesso: true });
    if (!senha || !verificaSenha(senha, u.senha_hash)) {
      return res.status(401).json({ erro: 'usuário ou senha inválidos' });
    }
    const token = novoToken();
    await db.criarSessao(token, u.login);
    res.json({ token, nome: u.nome, cargo: u.cargo });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// primeiro acesso: o próprio usuário define a senha (não existe senha comum)
app.post('/definir-senha', async (req, res) => {
  try {
    const { login, senha } = req.body || {};
    const u = await db.buscarUsuario(login);
    if (!u) return res.status(401).json({ erro: 'usuário inválido' });
    if (u.senha_hash) return res.status(409).json({ erro: 'senha já definida — use o login normal' });
    if (!senha || senha.length < 8) return res.status(400).json({ erro: 'a senha deve ter no mínimo 8 caracteres' });
    await db.gravarSenha(u.login, hashSenha(senha));
    const token = novoToken();
    await db.criarSessao(token, u.login);
    res.json({ token, nome: u.nome, cargo: u.cargo });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/logout', async (req, res) => {
  const t = req.get('X-Auth-Token');
  if (t) await db.encerrarSessao(t).catch(() => {});
  res.json({ ok: true });
});

// reset administrativo (tabelião): zera a senha; usuário redefine no próximo acesso
app.post('/admin/resetar-senha', async (req, res) => {
  if (req.get('X-Admin-Key') !== process.env.HUB_KEY) return res.status(401).json({ erro: 'não autorizado' });
  const u = await db.buscarUsuario(req.body?.login);
  if (!u) return res.status(404).json({ erro: 'usuário não encontrado' });
  await db.gravarSenha(u.login, null);
  res.json({ ok: true, login: u.login });
});

const exigeSessao = async (req, res, next) => {
  const sess = await db.sessaoValida(req.get('X-Auth-Token') || '');
  if (!sess) return res.status(401).json({ erro: 'sessão inválida ou expirada' });
  req.usuario = sess;
  next();
};

const NOMES_BANDEIRA = {
  verde: 'Loteador/Incorporador', amarelo: 'Construtor',
  rosa: 'Santa Mônica', roxo: 'Advogado', cinza: 'Corretor'
};
// ===== PRAZOS AUTOMÁTICOS DE LAVRATURA (fixados na criação; não dependem do escrevente) =====
// CV-U / CV-R / DOA: 5 dias ÚTEIS com bandeira de construtor/loteador (verde, amarelo
// ou rosa); 8 dias ÚTEIS sem bandeira de vendedor. INV: 4 úteis (advogado é regra).
// CDH: 4 úteis com advogado (roxo); 7 úteis sem. TEST: 3 úteis. CDP: 3 dias CORRIDOS.
function diasUteis(n) {
  const d = new Date(); let add = 0;
  while (add < n) { d.setDate(d.getDate() + 1); const wd = d.getDay(); if (wd !== 0 && wd !== 6) add++; }
  d.setHours(23, 59, 0, 0); return d;
}
function diasCorridos(n) { const d = new Date(Date.now() + n * 86400000); d.setHours(23, 59, 0, 0); return d; }
function prazoDoAto(p) {
  const f = p.bandeiras || [];
  const construtor = f.includes('verde') || f.includes('amarelo') || f.includes('rosa');
  switch (p.ato) {
    case 'CV-Urbano':
    case 'CV-Rural':
    case 'DOA':  return diasUteis(construtor ? 5 : 8);
    case 'INV':  return diasUteis(4);
    case 'CDH':  return diasUteis(f.includes('roxo') ? 4 : 7);
    case 'TEST': return diasUteis(3);
    case 'CDP':  return diasCorridos(3);
    default:     return diasUteis(8);
  }
}
const pad = n => String(n).padStart(4, '0');

// ---------- POST /protocolo — o coração do Momento 1 ----------
app.post('/protocolo', exigeSessao, async (req, res) => {
  const p = req.body || {};
  p.escrevente = req.usuario.nome; // identidade vem da sessão, nunca do formulário
  if (!p.ato || !p.apresentante?.nome || !p.apresentante?.telefone || !p.parte_envolvida?.nome) {
    return res.status(400).json({ erro: 'payload incompleto' });
  }
  try {
    // 1) número atômico + registro canônico
    const numero = await db.registrarProtocolo(p, req.usuario.login);
    const titulo = `Prot. (${p.ato}) ${pad(numero)} - ${p.parte_envolvida.nome.toUpperCase()}`;

    // 2) descrição: observações humanas + bloco de dados de máquina
    const bloco = ['<!--DADOS', JSON.stringify({ numero, ...p }, null, 1), 'DADOS-->'].join('\n');
    const desc = [
      p.observacoes_nao_documentadas ? `**OBSERVAÇÕES NÃO DOCUMENTADAS**\n${p.observacoes_nao_documentadas}` : '',
      bloco
    ].filter(Boolean).join('\n\n');

    // 3) bandeiramento -> labels por nome (cores semânticas do cartório)
    const labels = await trello.labelsDoQuadro(process.env.BOARD_00);
    const idLabels = [];
    if (p.urgente && labels['Urgente']) idLabels.push(labels['Urgente']);
    for (const b of (p.bandeiras || [])) {
      const nome = NOMES_BANDEIRA[b];
      if (nome && labels[nome]) idLabels.push(labels[nome]);
    }

    // 4) prazo automático por ato × bandeira (dias úteis; CDP em corridos)
    const due = prazoDoAto(p).toISOString();

    // 5) cartão em Protocolo/Entrada
    const card = await trello.criarCartao({
      idList: process.env.LISTA_ENTRADA, name: titulo, desc, due, idLabels
    });
    await db.vincularCartao(numero, card.id);

    // 6) campos personalizados (mapeados por nome)
    await trello.aplicarCampos(card.id, process.env.BOARD_00, {
      'Protocolo': numero,
      'Tipo de Ato': p.ato,
      'Apresentante': p.apresentante.nome,
      'Tel Apresentante': p.apresentante.telefone,
      'Parte': p.parte_envolvida.nome,
      'Tel Parte': p.parte_envolvida.telefone,
      'Data de Entrada': new Date().toISOString(),
      'Escrevente': p.escrevente,
      'Vendedor': p.vendedor?.nome
    });

    // 7) checklist DOSSIÊ (recebidos marcados, pendentes em aberto)
    await trello.criarChecklistDossie(card.id, p.dossie?.recebidos || [], p.dossie?.pendentes || []);

    // 8) recibos WhatsApp (não bloqueia a resposta do balcão)
    dispararRecibos(p, pad(numero)).catch(e => console.error('whats:', e.message));

    res.json({ numero: pad(numero), card_url: card.shortUrl, prazo: due });
  } catch (e) {
    console.error('protocolo:', e);
    res.status(500).json({ erro: 'falha ao protocolar', detalhe: e.message });
  }
});

// ---------- listas de configuração (⚙) com cache de 10 min ----------
const cacheConfig = new Map(); // listId -> {em, dados}
function parseConfig(cards, bandeiraPadrao) {
  return cards
    .filter(c => !c.name.startsWith('📋')) // ignora o cartão-modelo
    .map(c => {
      const ap = /apelidos:\s*(.+)/i.exec(c.desc || '');
      const sla = /sla_dias:\s*(\d+)/i.exec(c.desc || '');
      const bd = /bandeira:\s*(\w+)/i.exec(c.desc || '');
      return {
        nome: c.name,
        apelidos: ap ? ap[1].split(',').map(s => s.trim()) : [],
        sla_dias: sla ? parseInt(sla[1], 10) : null,
        bandeira: bd ? bd[1].toLowerCase() : bandeiraPadrao
      };
    });
}
async function listaConfig(listId, bandeiraPadrao) {
  const c = cacheConfig.get(listId);
  if (c && Date.now() - c.em < 10 * 60 * 1000) return c.dados;
  const dados = parseConfig(await trello.cartoesDaLista(listId), bandeiraPadrao);
  cacheConfig.set(listId, { em: Date.now(), dados });
  return dados;
}
app.get('/vendedores', async (_req, res) => {
  try { res.json(await listaConfig(process.env.LISTA_VENDEDORES, 'verde')); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});
app.get('/corretores', async (_req, res) => {
  try { res.json(await listaConfig(process.env.LISTA_CORRETORES, 'cinza')); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});
app.get('/advogados', async (_req, res) => {
  try { res.json(await listaConfig(process.env.LISTA_ADVOGADOS, 'roxo')); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// ---------- Webhook Trello: re-hidrata campos após viagem entre quadros ----------
// (campos personalizados NÃO acompanham o cartão ao trocar de quadro)
app.head('/webhook/trello', (_req, res) => res.sendStatus(200)); // validação do Trello
app.post('/webhook/trello', async (req, res) => {
  res.sendStatus(200); // responde já; processa depois
  try {
    const a = req.body?.action;
    if (a?.type !== 'moveCardToBoard') return;
    const cardId = a.data?.card?.id;
    const boardDestino = a.data?.board?.id; // quadro de destino
    if (!cardId || !boardDestino) return;
    const reg = await db.protocoloPorCartao(cardId);
    if (!reg) return;
    const p = reg.dados;
    await trello.aplicarCampos(cardId, boardDestino, {
      'Protocolo': reg.numero,
      'Tipo de Ato': p.ato,
      'Apresentante': p.apresentante?.nome,
      'Tel Apresentante': p.apresentante?.telefone,
      'Parte': p.parte_envolvida?.nome,
      'Tel Parte': p.parte_envolvida?.telefone,
      'Escrevente': p.escrevente,
      'Vendedor': p.vendedor?.nome
    });
    // labels também são por quadro: reaplica bandeiras + urgente no destino
    const nomes = (p.bandeiras || []).map(b => NOMES_BANDEIRA[b]).filter(Boolean);
    if (p.urgente) nomes.push('Urgente');
    await trello.aplicarLabelsPorNome(cardId, boardDestino, nomes);
    console.log(`re-hidratado: prot ${reg.numero} no quadro ${boardDestino}`);
  } catch (e) {
    console.error('webhook:', e.message);
  }
});

app.get('/saude', (_req, res) => res.json({ ok: true }));

db.init().then(() => {
  app.listen(process.env.PORT || 3000, () =>
    console.log('Hub de Protocolo CN2O no ar, porta', process.env.PORT || 3000));
}).catch(e => { console.error('init:', e); process.exit(1); });
