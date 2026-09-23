// server.js — Hub de Protocolo CN2O
const express = require('express');
const db = require('./db');
const trello = require('./trello');
const { dispararRecibos, statusWhatsApp, enviarTemplate, normalizaTelefone } = require('./whats');
const { hashSenha, verificaSenha, novoToken } = require('./auth');
const hub = require('./hub');   // router do Hub + vincularAnexosCert (v1.36)

const app = express();
// Corpo pequeno mantem o limite antigo; /agentes e /hub tem parser proprio
// (24 MB) porque recebem PDF e imagem em base64.
const jsonPequeno = express.json({ limit: '256kb' });
app.use((req, res, next) =>
  (req.path.startsWith('/agentes') || req.path.startsWith('/hub/'))
    ? next() : jsonPequeno(req, res, next));

// CORS: o formulário roda no Netlify
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Hub-Key, X-Auth-Token, X-Admin-Key');
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
// ===== CAPA DO CARTÃO — a bandeira vai para a capa (cor cheia), não só para a label =====
// Uma capa por cartão: rosa (Santa Mônica) > verde (loteador/incorporador) > amarelo
// (construtor) > roxo (advogado) > cinza (corretor). Urgente continua só como label vermelha.
const COR_CAPA = { rosa: 'pink', verde: 'green', amarelo: 'yellow', roxo: 'purple', cinza: 'black' };
const PRIORIDADE_CAPA = ['rosa', 'verde', 'amarelo', 'roxo', 'cinza'];
function corDaCapa(bandeiras) {
  const b = bandeiras || [];
  const k = PRIORIDADE_CAPA.find(x => b.includes(x));
  return k ? COR_CAPA[k] : null;
}
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
    case 'PER':
    case 'DOA':  return diasUteis(construtor ? 5 : 8);
    case 'INV':  return diasUteis(4);
    case 'CDH':  return diasUteis(f.includes('roxo') ? 4 : 7);
    case 'TEST': return diasUteis(3);
    case 'CDP':  return diasCorridos(3);
    case 'CERT': return diasUteis(3);   // v1.36: pedido de certidão/traslado
    default:     return diasUteis(8);
  }
}
// ---------- CERT: pedido de certidão / traslado (v1.36) ----------
// O cartão do CERT não vai para o quadro 00: vai para o quadro 04 · Certidões/
// Traslado, na lista de triagem, que é onde as escreventes das certidões
// trabalham. Os identificadores têm valor padrão porque são do quadro real da
// serventia — não são segredo, e as variáveis da Railway continuam mandando.
const CERT_BOARD = () => process.env.BOARD_04 || '6a8ca1ddc8f6574231ab8ab0';
const CERT_LISTA = () => process.env.LISTA_TRIAGEM_CERT || '6a8cbff5e564123504996c60';
const CERT_SITE = () => (process.env.HUB_SITE || 'https://cn2o-hub.netlify.app').replace(/\/+$/, '');
const SEM_DADO = 'não consta';

// "não consta" é resposta, não ausência: o solicitante DISSE que não tem o dado.
// Campo em branco é outra coisa — ninguém perguntou. O cartão precisa distinguir
// as duas, senão a escrevente pesquisa atrás de um dado que não existe.
function certCampo(v) {
  if (v === SEM_DADO) return '_não consta (declarado pelo solicitante)_';
  const s = String(v == null ? '' : v).trim();
  return s || '—';
}
function certDescricao(c, numero) {
  const a = (c && c.ato) || {};
  const s = (c && c.solicitante) || {};
  const p = (c && c.parte) || {};
  const linhas = [
    '**PEDIDO DE CERTIDÃO / TRASLADO**',
    '',
    '**Solicitante**',
    '- Nome: ' + certCampo(s.nome),
    '- RG: ' + certCampo(s.rg),
    '- Telefone: ' + certCampo(s.telefone),
    '',
    '**Pessoa que participa do ato**',
    '- Nome: ' + certCampo(p.nome),
    '- Pai: ' + certCampo(p.pai),
    '- Mãe: ' + certCampo(p.mae),
    '',
    '**Dados do ato informados**',
    '- Natureza: ' + certCampo(a.natureza),
    '- Livro: ' + certCampo(a.livro),
    '- Folhas: ' + certCampo(a.folhas),
    '- Data: ' + certCampo(a.data),
    '- Espécie pedida: ' + certCampo(c && c.especie)
  ];
  const informado = v => { const t = String(v == null ? '' : v).trim(); return t && t !== SEM_DADO; };
  if (!informado(a.livro) && !informado(a.folhas) && !informado(a.data)) {
    linhas.push('', '> ⚠ Pedido SEM referência de livro, folhas ou data: a pesquisa parte do nome e da filiação.');
  }
  const anexos = (c && Array.isArray(c.anexos)) ? c.anexos : [];
  linhas.push('', '**Documentos anexados pelo solicitante**');
  if (!anexos.length) linhas.push('- nenhum');
  else anexos.forEach(x => linhas.push(
    '- [' + String(x.nome || 'documento').replace(/[\[\]]/g, '') + '](' +
    CERT_SITE() + '/anexo.html#' + encodeURIComponent(String(x.id || '')) + ')'
  ));
  if (anexos.length) {
    linhas.push('', '_Os anexos abrem com a sua senha do Hub. Não são link público._');
  }
  return linhas.join('\n');
}

const pad = n => String(n).padStart(4, '0');

// v1.37 — preço ajustado (valor declarado pelas partes). A tela manda `preco` no
// topo do payload; protocolos antigos só têm triagem.preco/valores. Texto curto,
// sem quebra de linha — é dado de cartão e de extrato, não de escritura.
function precoDoProtocolo(p) {
  const t = p && p.triagem;
  const v = (p && (p.preco || (t && (t.preco || t.valores || t.valor)))) || '';
  // sem marcação de markdown: o valor vai dentro de **…** na descrição do cartão
  return String(v).replace(/[*_\[\]`<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
}
function rotuloPreco(ato) {
  if (ato === 'DOA') return 'VALOR ATRIBUÍDO AO BEM DOADO';
  if (ato === 'PER') return 'PREÇO AJUSTADO (valores atribuídos)';
  return 'PREÇO AJUSTADO';
}

// ---------- POST /protocolo — o coração do Momento 1 ----------
app.post('/protocolo', exigeSessao, async (req, res) => {
  const p = req.body || {};
  p.escrevente = req.usuario.nome; // identidade vem da sessão, nunca do formulário
  if (!p.ato || !p.apresentante?.nome || !p.apresentante?.telefone || !p.parte_envolvida?.nome) {
    return res.status(400).json({ erro: 'payload incompleto' });
  }
  // CERT: a regra do Tabelião — pedido que só traz o nome da pessoa do ato exige
  // filiação, porque sem livro, folhas nem data a pesquisa no acervo se faz pelo
  // nome, e nome sozinho não distingue homônimo.
  if (p.ato === 'CERT') {
    const c = p.cert || {};
    const dado = v => { const t = String(v == null ? '' : v).trim(); return (t && t !== SEM_DADO) ? t : ''; };
    const temRef = dado(c.ato?.livro) || dado(c.ato?.folhas) || dado(c.ato?.data);
    const temFiliacao = dado(c.parte?.pai) || dado(c.parte?.mae);
    // v1.36.1 (LGPD): a pessoa do ato é terceiro — o recibo do WhatsApp não pode
    // avisá-la de que alguém pediu certidão de ato dela. Só o solicitante recebe.
    if (p.parte_envolvida) p.parte_envolvida.telefone = null;
    if (Array.isArray(p.recibo_destinatarios)) p.recibo_destinatarios = p.recibo_destinatarios.filter(d => d !== 'parte_envolvida');
    if (!temRef && !temFiliacao) {
      return res.status(400).json({
        erro: 'pedido sem livro, folhas ou data: informe a filiação da pessoa que participa do ato'
      });
    }
  }
  try {
    // 1) número atômico + registro canônico
    const numero = await db.registrarProtocolo(p, req.usuario.login);
    const titulo = `Prot. (${p.ato}) ${pad(numero)} - ${p.parte_envolvida.nome.toUpperCase()}`;

    // 2) descrição: observações humanas + bloco de dados de máquina
    const ehCert = p.ato === 'CERT';
    const quadro = ehCert ? CERT_BOARD() : process.env.BOARD_00;
    const listaDestino = ehCert ? CERT_LISTA() : process.env.LISTA_ENTRADA;
    const pendentes = (p.dossie && p.dossie.pendentes) || [];
    const bloco = ['<!--DADOS', JSON.stringify({ numero, ...p }, null, 1), 'DADOS-->'].join('\n');
    // v1.37 — preço ajustado / valor declarado pelas partes, em destaque no cartão
    const preco = precoDoProtocolo(p);
    const desc = [
      preco ? `**${rotuloPreco(p.ato)}: ${preco}**` : '',
      ehCert ? certDescricao(p.cert, numero) : '',
      p.observacoes_nao_documentadas ? `**OBSERVAÇÕES NÃO DOCUMENTADAS**\n${p.observacoes_nao_documentadas}` : '',
      (pendentes.length ? (p.ato === 'CERT'
        ? '**DOCUMENTOS PENDENTES — conferir com o solicitante antes de expedir**\n- '
        : '**DOCUMENTOS PENDENTES — cobrar do interessado antes da lavratura**\n- ') + pendentes.join('\n- ') : ''),
      bloco
    ].filter(Boolean).join('\n\n');

    // 3) bandeiramento -> labels por nome (cores semânticas do cartório)
    // v1.36.1: no quadro 04 as etiquetas não podem derrubar o protocolo do CERT
    const labels = ehCert
      ? await trello.labelsDoQuadro(quadro).catch(e => { console.error('labels (cert):', e.message); return {}; })
      : await trello.labelsDoQuadro(quadro);
    const idLabels = [];
    if (p.urgente && labels['Urgente']) idLabels.push(labels['Urgente']);
    if (pendentes.length && labels['Doc. pendente']) idLabels.push(labels['Doc. pendente']);
    for (const b of (p.bandeiras || [])) {
      const nome = NOMES_BANDEIRA[b];
      if (nome && labels[nome]) idLabels.push(labels[nome]);
    }

    // 4) prazo automático por ato × bandeira (dias úteis; CDP em corridos)
    const due = prazoDoAto(p).toISOString();

    // 5) cartão em Protocolo/Entrada
    const card = await trello.criarCartao({
      idList: listaDestino, name: titulo, desc, due, idLabels
    });
    await db.vincularCartao(numero, card.id);

    // 5a) CERT: carimba o número nos anexos já enviados (eles nasceram sem protocolo).
    // Falhar aqui não desfaz o protocolo — o anexo continua no banco, com a trilha.
    if (ehCert) {
      hub.limparAnexosCert();   // v1.36.1: expurgo também a cada protocolo CERT
      await hub.vincularAnexosCert(((p.cert && p.cert.anexos) || []).map(x => x && x.id), numero)
        .catch(e => console.error('cert anexos:', e.message));
    }

    // 5b) capa colorida = bandeira (não bloqueia o protocolo se falhar)
    const capa = corDaCapa(p.bandeiras);
    if (capa) await trello.aplicarCapa(card.id, capa).catch(e => console.error('capa:', e.message));

    // 6) campos personalizados (mapeados por nome)
    const campos = trello.aplicarCampos(card.id, quadro, {
      'Protocolo': numero,
      'Tipo de Ato': p.ato,
      'Apresentante': p.apresentante.nome,
      'Tel Apresentante': p.apresentante.telefone,
      'Parte': p.parte_envolvida.nome,
      'Tel Parte': p.parte_envolvida.telefone,
      'Data de Entrada': new Date().toISOString(),
      'Escrevente': p.escrevente,
      'Vendedor': p.vendedor?.nome,
      'Preço ajustado': precoDoProtocolo(p) || undefined   // v1.37 — só se o quadro tiver o campo
    });
    // o quadro das certidões não tem os mesmos campos personalizados do quadro 00:
    // campo inexistente lá é ignorado, e uma falha não pode derrubar o protocolo.
    // v1.37: também nos demais atos — o cartão já existe e o número já foi consumido;
    // um campo personalizado recusado (ex.: tipo número no quadro) não pode virar
    // "falha ao protocolar" no balcão.
    await campos.catch(e => console.error('campos' + (ehCert ? ' (cert)' : '') + ':', e.message));

    // 7) checklist DOSSIÊ (recebidos marcados, pendentes em aberto)
    await trello.criarChecklistDossie(card.id, p.dossie?.recebidos || [], p.dossie?.pendentes || []);

    // 8) recibos WhatsApp (não bloqueia a resposta do balcão)
    dispararRecibos(p, pad(numero))
      .then(resps => {
        const falhas = (resps || []).filter(r => !r.ok);
        if (falhas.length) {
          console.error(`[WhatsApp] Prot ${pad(numero)} teve falhas de envio:`, falhas);
        } else {
          console.log(`[WhatsApp] Prot ${pad(numero)} todos os recibos enviados com sucesso.`);
        }
      })
      .catch(e => console.error('[WhatsApp] Erro inesperado em dispararRecibos:', e.message));

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
      'Vendedor': p.vendedor?.nome,
      'Preço ajustado': precoDoProtocolo(p) || undefined   // v1.37 — só se o quadro tiver o campo
    });
    // labels também são por quadro: reaplica bandeiras + urgente no destino
    const nomes = (p.bandeiras || []).map(b => NOMES_BANDEIRA[b]).filter(Boolean);
    if (p.urgente) nomes.push('Urgente');
    if (await trello.temPendenciaDossie(cardId)) nomes.push('Doc. pendente');
    await trello.aplicarLabelsPorNome(cardId, boardDestino, nomes);
    // a capa viaja com o cartão, mas reaplica por garantia
    const capa = corDaCapa(p.bandeiras);
    if (capa) await trello.aplicarCapa(cardId, capa).catch(e => console.error('capa:', e.message));
    console.log(`re-hidratado: prot ${reg.numero} no quadro ${boardDestino}`);
  } catch (e) {
    console.error('webhook:', e.message);
  }
});

app.get('/saude', (_req, res) => res.json({ ok: true }));

// Diagnóstico do WhatsApp: status da configuração, template ativo e histórico recente
app.get('/whats/status', (_req, res) => {
  res.json(statusWhatsApp());
});

// Teste direto de envio para validar template, token e telefone em tempo real
app.post('/whats/testar', async (req, res) => {
  const key = req.get('X-Admin-Key') || req.get('X-Hub-Key');
  const sess = await db.sessaoValida(req.get('X-Auth-Token') || '');
  if (!sess && key !== process.env.HUB_KEY) {
    return res.status(401).json({ erro: 'não autorizado' });
  }
  const { telefone, protocolo, ato, template } = req.body || {};
  if (!telefone) return res.status(400).json({ erro: 'telefone obrigatório' });

  const { variaveisDoRecibo } = require('./recibo');
  const tpl = String(template || process.env.WHATS_TEMPLATE_RECIBO || 'recibo_protocolo_2').trim();
  const fakeProto = {
    ato: ato || 'CV-Urbano',
    apresentante: { nome: 'Apresentante (Teste)', telefone },
    parte_envolvida: { nome: 'Parte Envolvida (Teste)', telefone },
    vendedor: { nome: 'Vendedor/Cedente (Teste)' }
  };
  const vars = variaveisDoRecibo(fakeProto, protocolo || '9999', tpl);
  const resultado = await enviarTemplate(telefone, vars, tpl);
  res.json({
    telefone_informado: telefone,
    telefone_normalizado: normalizaTelefone(telefone),
    template_usado: tpl,
    variaveis: vars,
    resultado
  });
});


// --- Hub de Agentes (redacao de atos) ------------------------------------
// Herda sessao, banco e usuarios do hub de protocolo que ja roda aqui.
app.use('/agentes', exigeSessao, require('./agentes'));

// --- Hub CN2O (mural do Time + Extrator e Analista com IA) ----------------
// Mesma sessão, mesmo banco e mesma chave do Gemini; o site fica no Netlify.
app.use('/hub', hub);

// A interface (public/index.html). Fica por ultimo entre os middlewares
// para nao sombrear nenhuma rota da API.
app.use(express.static(require('path').join(__dirname, 'public')));

db.init()
  .then(() => require('./db-agentes').init())
  .then(() => app.listen(process.env.PORT || 3000, () =>
    console.log('CN2O hub no ar')))
  .catch(e => { console.error('falha no boot:', e); process.exit(1); });
