// server.js — Hub de Protocolo CN2O
const express = require('express');
const db = require('./db');
const trello = require('./trello');
const { dispararRecibos, statusWhatsApp, enviarTemplate, normalizaTelefone } = require('./whats');
const hub = require('./hub');   // router do Hub + vincularAnexosCert (v1.36)
const { variaveisDoReciboCert, templateCert } = require('./recibo-cert');   // v1.37.1 — recibo próprio do CERT
const rastreio = require('./rastreio');   // v1.38 — rastreio dos cartões para os relatórios das escreventes

const app = express();
// v1.39.1: atrás do proxy da Railway, req.ip é o IP do cliente (o último salto que o proxy
// acrescenta ao X-Forwarded-For) — não o primeiro valor, que o próprio cliente forja.
app.set('trust proxy', 1);
// v1.39.2 (segurança, pacote B): cabeçalhos de segurança e CORS só para o site do Hub
// (antes: "*", qualquer site). Outras origens: CORS_ORIGENS=https://a,https://b. Ver protecao.js.
const protecao = require('./protecao');
app.disable('x-powered-by');
app.use(protecao.cabecalhos);
app.use(protecao.cors());
// Corpo pequeno mantem o limite antigo; /agentes e /hub tem parser proprio
// (24 MB) porque recebem PDF e imagem em base64. v1.38: /webhook/trello le o
// corpo BRUTO, porque a assinatura do Trello e calculada sobre os bytes exatos.
const jsonPequeno = express.json({ limit: '256kb' });
app.use((req, res, next) =>
  (req.path.startsWith('/agentes') || req.path.startsWith('/hub/') || req.path === '/webhook/trello')
    ? next() : jsonPequeno(req, res, next));

// ---------- autenticação individual (nome.sobrenome + senha própria) ----------
// v1.39.1 (segurança): /login, /definir-senha e /logout moram em acesso.js — primeiro
// acesso só com o código do Tabelião, limite de tentativas e resposta única. A rota
// antiga /admin/resetar-senha (HUB_KEY, o código dos balcões, zerava a senha de
// qualquer um) saiu: quem zera senha agora é o Tabelião, na aba Equipe (código novo).
app.use(require('./acesso').router);

// v1.39.2: a HUB_KEY não vale mais para nada (o teste do WhatsApp passou a exigir sessão
// de administrador). A variável pode ser apagada da Railway.

// v1.39.1: falha do banco vira 500 (antes, a promessa rejeitada sem catch derrubava o processo)
const exigeSessao = async (req, res, next) => {
  let sess;
  try { sess = await db.sessaoValida(req.get('X-Auth-Token') || ''); }
  catch (e) { console.error('sessão:', e.message); return res.status(500).json({ erro: 'falha ao validar a sessão' }); }
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
    // v1.37.1 — CERT com template próprio (WHATS_TEMPLATE_CERT): só o solicitante
    // recebe, com "Pedido" e "Ato procurado em nome de" no lugar de "Comprador(a)".
    // Sem a variável, o CERT segue pelo recibo comum (dispararRecibos), como antes.
    const envio = (ehCert && templateCert())
      ? enviarTemplate(p.apresentante.telefone, variaveisDoReciboCert(p, pad(numero)), templateCert()).then(r => [r])
      : dispararRecibos(p, pad(numero));
    envio
      .then(resps => {
        const falhas = (resps || []).filter(r => !r.ok);
        if (falhas.length) {
          // v1.39.4: sem telefone inteiro nem a resposta crua da Meta no log
          console.error(`[WhatsApp] Prot ${pad(numero)} teve falhas de envio:`, falhas.map(f => ({ para: protecao.mascaraTel(f.to), motivo: f.motivo })));
        } else {
          console.log(`[WhatsApp] Prot ${pad(numero)} todos os recibos enviados com sucesso.`);
        }
      })
      .catch(e => console.error('[WhatsApp] Erro inesperado em dispararRecibos:', e.message));

    res.json({ numero: pad(numero), card_url: card.shortUrl, prazo: due });
  } catch (e) {
    console.error('protocolo:', e);
    res.status(500).json({ erro: 'falha ao protocolar — tente de novo; se continuar, avise o suporte' });   // v1.39.2: o detalhe fica só no log
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
  catch (e) { console.error('lista (' + _req.path + '):', e.message); res.status(500).json({ erro: 'falha ao ler a lista' }); }
});
app.get('/corretores', async (_req, res) => {
  try { res.json(await listaConfig(process.env.LISTA_CORRETORES, 'cinza')); }
  catch (e) { console.error('lista (' + _req.path + '):', e.message); res.status(500).json({ erro: 'falha ao ler a lista' }); }
});
app.get('/advogados', async (_req, res) => {
  try { res.json(await listaConfig(process.env.LISTA_ADVOGADOS, 'roxo')); }
  catch (e) { console.error('lista (' + _req.path + '):', e.message); res.status(500).json({ erro: 'falha ao ler a lista' }); }
});

// ---------- Webhook Trello ----------
// 1) re-hidrata campos após viagem entre quadros (campos personalizados NÃO
//    acompanham o cartão ao trocar de quadro);
// 2) v1.38: rastreia os cartões para os relatórios das escreventes (rastreio.js).
// A assinatura do Trello (X-Trello-Webhook + TRELLO_SECRET) decide SÓ o rastreio:
// sem ela, ou com ela errada, nada entra nas métricas, e a re-hidratação segue como
// sempre — um segredo mal configurado não pode parar o trabalho dos quadros. Ação
// que não chegou a ser gravada volta pela reconciliação das 7h (agendador.js).
let relatoriosNoAr = false;   // as tabelas do rastreio subiram no boot (db-relatorios.js)
let atendimentosNoAr = false; // v1.39: as tabelas dos atendimentos (NextQS) subiram no boot
app.head('/webhook/trello', (_req, res) => res.sendStatus(200)); // validação do Trello
app.post('/webhook/trello', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
  const corpo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  let a;
  try { a = JSON.parse(corpo.toString('utf8') || '{}').action; }
  catch (_) { return res.sendStatus(400); }
  let rastreado = false;
  // uma verificação só (ela conta as entregas inválidas para o painel)
  const assinatura = rastreio.verificarWebhook(corpo, req.get('X-Trello-Webhook'));
  if (relatoriosNoAr && rastreio.relevante(a) && assinatura === 'ok') {
    // gravada ANTES do 200: quando o Trello recebe a resposta, a ação já está no banco
    try { await rastreio.registrarEvento(a, 'webhook'); rastreado = true; }
    catch (e) { console.error('webhook (rastreio):', e.message); }
  }
  res.sendStatus(200); // responde já; processa depois
  if (rastreado) {
    rastreio.processarCartao(a.data.card.id).catch(e => console.error('webhook (rastreio):', e.message));
  }
  // v1.39.2 (segurança, pacote B): a re-hidratação ESCREVE no Trello, então só com a
  // assinatura válida. Sem TRELLO_SECRET configurado (instalação nova), só para os quadros
  // da própria serventia — um pedido forjado de fora não move nada.
  if (protecao.podeReidratar(assinatura, a && a.data && a.data.board && a.data.board.id, quadrosDaCasa())) {
    reidratarCampos(a).catch(e => console.error('webhook:', e.message));
  }
});
function quadrosDaCasa() {
  return [...require('./carga_retroativa').quadrosPadrao(), String(process.env.BOARD_04 || '6a8ca1ddc8f6574231ab8ab0').trim()];
}
async function reidratarCampos(a) {
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
}

app.get('/saude', (_req, res) => res.json({ ok: true }));

// v1.39.2 (segurança, pacote B): o diagnóstico do WhatsApp era público e devolvia os
// telefones dos últimos envios (clientes). Agora: sessão de administrador (HUB_ADMINS),
// telefones mascarados, e o teste só com os templates da casa, registrado na trilha.
const exigeAdminHub = (req, res, next) => (hub.ehAdmin(req.usuario) ? next() : res.status(403).json({ erro: 'só o Tabelião' }));
const mascaraTel = protecao.mascaraTel;

// Diagnóstico do WhatsApp: status da configuração, template ativo e histórico recente
app.get('/whats/status', exigeSessao, exigeAdminHub, (_req, res) => {
  const st = statusWhatsApp();
  res.json({ ...st, ultimos_envios: (st.ultimos_envios || []).map(e => ({ ...e, telOriginal: mascaraTel(e.telOriginal), to: mascaraTel(e.to) })) });
});

// Teste direto de envio para validar template, token e telefone em tempo real
app.post('/whats/testar', exigeSessao, exigeAdminHub, async (req, res) => {
  const { telefone, protocolo, ato, template } = req.body || {};
  if (!telefone) return res.status(400).json({ erro: 'telefone obrigatório' });
  const permitidos = new Set(['recibo_protocolo_2', 'recibo_protocolo_3', 'recibo_certidao_1',
    String(process.env.WHATS_TEMPLATE_RECIBO || '').trim(), String(templateCert() || '').trim()].filter(Boolean));
  if (template && !permitidos.has(String(template).trim())) {
    return res.status(400).json({ erro: 'template fora da lista da casa: ' + [...permitidos].join(', ') });
  }
  hub.auditar(req, 'admin', 'whats-teste', 'teste de WhatsApp para ' + mascaraTel(telefone));

  const { variaveisDoRecibo } = require('./recibo');
  const ehCertTeste = String(ato || '').toUpperCase() === 'CERT';
  if (ehCertTeste && !template && !templateCert()) {
    return res.status(400).json({ erro: 'WHATS_TEMPLATE_CERT não configurado — informe `template` ou grave a variável na Railway' });
  }
  const tpl = String(template || (ehCertTeste && templateCert()) || process.env.WHATS_TEMPLATE_RECIBO || 'recibo_protocolo_2').trim();
  const fakeProto = {
    ato: ato || 'CV-Urbano',
    apresentante: { nome: 'Apresentante (Teste)', telefone },
    parte_envolvida: { nome: 'Parte Envolvida (Teste)', telefone },
    vendedor: { nome: 'Vendedor/Cedente (Teste)' },
    cert: { especie: 'Certidão de inteiro teor (Teste)', solicitante: { nome: 'Solicitante (Teste)' }, parte: { nome: 'Pessoa do Ato (Teste)' } }
  };
  // v1.37.1 — teste do recibo do CERT: ato=CERT usa as variáveis do template próprio
  const vars = ehCertTeste ? variaveisDoReciboCert(fakeProto, protocolo || '9999') : variaveisDoRecibo(fakeProto, protocolo || '9999', tpl);
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

// --- v1.38 Relatórios das escreventes (semanal e mensal, por e-mail) -------
// Antes do /hub: o relatorios.js exige a sessão de um administrador (HUB_ADMINS ou
// RELATORIOS_ADMINS) em todas as rotas. Ver RELATORIOS.md.
app.use('/hub/relatorios', require('./relatorios').router);

// --- Hub CN2O (mural do Time + Extrator e Analista com IA) ----------------
// Mesma sessão, mesmo banco e mesma chave do Gemini; o site fica no Netlify.
app.use('/hub', hub);

// A interface (public/index.html). Fica por ultimo entre os middlewares
// para nao sombrear nenhuma rota da API.
app.use(express.static(require('path').join(__dirname, 'public')));

// v1.39.2 (segurança, pacote B): erro que escapou das rotas (JSON malformado, corpo
// grande demais, exceção) vira resposta genérica; o detalhe fica só no log. Sem isto o
// Express devolve a pilha de execução quando NODE_ENV não é "production".
app.use(protecao.tratadorDeErros);

// v1.38: as tabelas dos relatórios não derrubam o hub — sem elas, o protocolo e o resto
// sobem normalmente, o rastreio fica desligado e o agendador não inicia.
db.init()
  .then(() => require('./db-agentes').init())
  .then(() => require('./db-relatorios').init()
    .then(() => { relatoriosNoAr = true; })
    .catch(e => console.error('relatórios das escreventes desligados (tabelas):', e.message)))
  // v1.39: tabelas dos atendimentos (NextQS) — idem, não derrubam o resto
  .then(() => require('./atendimentos').init()
    .then(() => { atendimentosNoAr = true; })
    .catch(e => console.error('atendimentos (NextQS) desligados (tabelas):', e.message)))
  // v1.40: produtividade em reais (tabelas e a carga inicial de jun–ago/2026) — idem
  .then(() => require('./produtividade').init()
    .catch(e => console.error('produtividade desligada (tabelas):', e.message)))
  .then(() => app.listen(process.env.PORT || 3000, () => {
    console.log('CN2O hub no ar');
    if (relatoriosNoAr || atendimentosNoAr) {
      require('./agendador').iniciar({ relatorios: relatoriosNoAr, atendimentos: atendimentosNoAr });
    }
  }))
  .catch(e => { console.error('falha no boot:', e); process.exit(1); });
