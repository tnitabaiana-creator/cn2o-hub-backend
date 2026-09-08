// agentes.js — módulo de redação de atos do Hub CN2O.
//
// Monta-se em server.js com uma linha:
//     app.use('/agentes', exigeSessao, require('./agentes'));
//
// Todas as rotas assumem req.usuario = { login, nome, cargo }, entregue pelo
// middleware exigeSessao que já existe. Nada aqui reimplementa autenticação.

const express = require('express');
const dba = require('./db-agentes');
const gemini = require('./gemini');
const docx = require('./docx');
const { pool } = require('./db');

const router = express.Router();

// Anexos chegam em base64 no corpo JSON. O limite global do express.json é de
// 256kb — insuficiente para uma matrícula escaneada. Este parser vale só aqui.
const LIMITE_UPLOAD = process.env.LIMITE_UPLOAD || '24mb';
router.use(express.json({ limit: LIMITE_UPLOAD }));

// Só quem manda na redação mexe no cadastro de agentes.
const CARGOS_ADMIN = ['Tabelião', 'Substituta do Tabelião'];
const ehAdmin = u => CARGOS_ADMIN.includes(u.cargo) ||
  (process.env.AGENTES_ADMIN || '').split(',').map(s => s.trim()).includes(u.login);

const erro = (res, code, msg, detalhe) =>
  res.status(code).json(detalhe ? { erro: msg, detalhe } : { erro: msg });

// ---------------------------------------------------------------- CATÁLOGO

// GET /agentes — os cards do painel.
router.get('/', async (req, res) => {
  try {
    res.json(await dba.listarAgentes(ehAdmin(req.usuario) && req.query.todos === '1'));
  } catch (e) { erro(res, 500, 'falha ao listar agentes', e.message); }
});

// GET /agentes/modelos — o que a chave do Gemini enxerga de verdade.
// Use isto para conferir os IDs antes de culpar o código.
router.get('/modelos', async (req, res) => {
  try {
    res.json({
      configurado: { extracao: gemini.MODELO_EXTRACAO, redacao: gemini.MODELO_REDACAO },
      disponiveis: await gemini.listarModelos()
    });
  } catch (e) { erro(res, 502, 'falha ao consultar os modelos', e.message); }
});

// GET /agentes/consumo — quanto a plataforma gastou. Só admin.
router.get('/consumo', async (req, res) => {
  if (!ehAdmin(req.usuario)) return erro(res, 403, 'somente Tabelião ou Substituta');
  try {
    const r = await dba.resumoConsumo(Math.min(365, parseInt(req.query.dias, 10) || 30));
    const cambio = parseFloat(process.env.CAMBIO_USD_BRL || '5.12');
    res.json({ ...r, cambio, total_brl: Number((r.total.usd || 0) * cambio).toFixed(2) });
  } catch (e) { erro(res, 500, 'falha ao apurar consumo', e.message); }
});

// GET /agentes/minutas — as minutas do usuário (ou todas, se admin).
router.get('/minutas', async (req, res) => {
  try {
    res.json(await dba.listarMinutas({
      usuario: req.usuario.login,
      todos: ehAdmin(req.usuario) && req.query.todos === '1',
      limite: Math.min(200, parseInt(req.query.limite, 10) || 50)
    }));
  } catch (e) { erro(res, 500, 'falha ao listar minutas', e.message); }
});

// GET /agentes/minutas/:id — minuta completa, com o histórico de ajustes.
router.get('/minutas/:id', async (req, res) => {
  try {
    const m = await dba.obterMinuta(parseInt(req.params.id, 10));
    if (!m) return erro(res, 404, 'minuta não encontrada');
    if (m.usuario !== req.usuario.login && !ehAdmin(req.usuario)) return erro(res, 403, 'minuta de outra escrevente');
    res.json(m);
  } catch (e) { erro(res, 500, 'falha ao abrir a minuta', e.message); }
});

// GET /agentes/minutas/:id/arquivo — baixa o Word.
router.get('/minutas/:id/arquivo', async (req, res) => {
  try {
    const m = await dba.obterMinuta(parseInt(req.params.id, 10));
    if (!m) return erro(res, 404, 'minuta não encontrada');
    if (m.usuario !== req.usuario.login && !ehAdmin(req.usuario)) return erro(res, 403, 'minuta de outra escrevente');
    if (!m.texto) return erro(res, 409, 'esta minuta ainda não foi redigida');

    const ag = await dba.obterAgente(m.agente);
    const html = docx.gerar({
      texto: m.texto,
      titulo: m.titulo || (ag && ag.nome) || 'Minuta',
      protocolo: m.protocolo,
      agente: ag && ag.nome,
      escrevente: m.usuario
    });
    const nome = docx.nomeArquivo({ protocolo: m.protocolo, agente: m.agente, titulo: m.titulo });
    res.setHeader('Content-Type', 'application/msword; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
    res.send(html);
  } catch (e) { erro(res, 500, 'falha ao gerar o arquivo', e.message); }
});

// ---------------------------------------------------------------- PIPELINE

// POST /agentes/:slug/extrair
// { arquivos: [{nome, mime, base64}], observacoes?, protocolo? }
// → { minuta_id, dados, alertas, uso }
// Etapa barata: lê os documentos e devolve o JSON para a escrevente CONFERIR.
// Nada é redigido aqui — de propósito.
router.post('/:slug/extrair', async (req, res) => {
  try {
    const ag = await dba.obterAgente(req.params.slug);
    if (!ag || !ag.ativo) return erro(res, 404, 'agente não encontrado');

    const arquivos = Array.isArray(req.body.arquivos) ? req.body.arquivos : [];
    if (!arquivos.length && !req.body.observacoes) {
      return erro(res, 400, 'anexe ao menos um documento ou escreva as observações do caso');
    }

    const { dados, uso } = await gemini.extrair({
      agente: ag, arquivos, observacoes: req.body.observacoes
    });

    const alertas = Array.isArray(dados._alertas) ? dados._alertas : [];
    delete dados._alertas;

    const m = await dba.criarMinuta({
      protocolo: req.body.protocolo ? parseInt(req.body.protocolo, 10) : null,
      agente: ag.slug,
      usuario: req.usuario.login,
      titulo: req.body.titulo || ag.nome,
      dados, alertas
    });

    await dba.registrarConsumo({
      minuta_id: m.id, usuario: req.usuario.login, agente: ag.slug, etapa: 'extracao', uso
    });

    res.json({
      minuta_id: m.id, dados, alertas,
      campos: ag.campos,
      uso: { modelo: uso.modelo, tokens_entrada: uso.tokens_entrada, tokens_saida: uso.tokens_saida, custo_usd: uso.custo_usd }
    });
  } catch (e) { erro(res, 502, 'falha na extração dos documentos', e.message); }
});

// POST /agentes/minutas/:id/redigir
// { dados?, observacoes? } — dados = o JSON já corrigido na tela.
// → { texto, uso }
router.post('/minutas/:id/redigir', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const m = await dba.obterMinuta(id);
    if (!m) return erro(res, 404, 'minuta não encontrada');
    if (m.usuario !== req.usuario.login && !ehAdmin(req.usuario)) return erro(res, 403, 'minuta de outra escrevente');

    const ag = await dba.obterAgente(m.agente);
    if (!ag) return erro(res, 404, 'agente não encontrado');

    // O que a escrevente conferiu na tela manda; o que veio da extração é só ponto de partida.
    const dados = req.body.dados && typeof req.body.dados === 'object' ? req.body.dados : m.dados;

    const { texto, uso } = await gemini.redigir({
      agente: ag, dados, observacoes: req.body.observacoes
    });

    await dba.atualizarMinuta(id, { dados, texto, status: 'redigida' });
    await dba.registrarTurno(id, 'agente', texto);
    await dba.registrarConsumo({
      minuta_id: id, usuario: req.usuario.login, agente: ag.slug, etapa: 'redacao', uso
    });

    res.json({
      minuta_id: id, texto,
      uso: { modelo: uso.modelo, tokens_entrada: uso.tokens_entrada, tokens_saida: uso.tokens_saida, custo_usd: uso.custo_usd }
    });
  } catch (e) { erro(res, 502, 'falha ao redigir a minuta', e.message); }
});

// POST /agentes/minutas/:id/revisar
// { pedido } → { texto, uso }
router.post('/minutas/:id/revisar', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const pedido = (req.body.pedido || '').trim();
    if (!pedido) return erro(res, 400, 'escreva o ajuste que você quer na minuta');

    const m = await dba.obterMinuta(id);
    if (!m) return erro(res, 404, 'minuta não encontrada');
    if (m.usuario !== req.usuario.login && !ehAdmin(req.usuario)) return erro(res, 403, 'minuta de outra escrevente');
    if (!m.texto) return erro(res, 409, 'redija a minuta antes de pedir revisão');

    const ag = await dba.obterAgente(m.agente);
    const historico = (m.turnos || []).filter(t => t.papel === 'usuario').map(t => t.conteudo);

    const { texto, uso } = await gemini.revisar({
      agente: ag, minutaAtual: m.texto, pedido, historico
    });

    await dba.registrarTurno(id, 'usuario', pedido);
    await dba.registrarTurno(id, 'agente', texto);
    await dba.atualizarMinuta(id, { texto, status: 'revisada' });
    await dba.registrarConsumo({
      minuta_id: id, usuario: req.usuario.login, agente: m.agente, etapa: 'revisao', uso
    });

    res.json({
      minuta_id: id, texto,
      uso: { modelo: uso.modelo, tokens_entrada: uso.tokens_entrada, tokens_saida: uso.tokens_saida, custo_usd: uso.custo_usd }
    });
  } catch (e) { erro(res, 502, 'falha ao revisar a minuta', e.message); }
});

// POST /agentes/minutas/:id/salvar — edição manual do texto, sem gastar token.
router.post('/minutas/:id/salvar', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const m = await dba.obterMinuta(id);
    if (!m) return erro(res, 404, 'minuta não encontrada');
    if (m.usuario !== req.usuario.login && !ehAdmin(req.usuario)) return erro(res, 403, 'minuta de outra escrevente');

    const campos = {};
    if (typeof req.body.texto === 'string') campos.texto = req.body.texto;
    if (typeof req.body.titulo === 'string') campos.titulo = req.body.titulo;
    if (req.body.dados && typeof req.body.dados === 'object') campos.dados = req.body.dados;
    if (typeof req.body.status === 'string') campos.status = req.body.status;
    if (!Object.keys(campos).length) return erro(res, 400, 'nada para salvar');

    res.json(await dba.atualizarMinuta(id, campos));
  } catch (e) { erro(res, 500, 'falha ao salvar', e.message); }
});

// ---------------------------------------------------------- PROTOCOLO (ponte)

// GET /agentes/protocolo/:numero — traz o payload do balcão para pré-preencher
// o ato. É o elo com o Hub de Protocolo que já roda: partes, telefones,
// tipo de ato e checklist do dossiê já estão em protocolos.dados.
router.get('/protocolo/:numero', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT numero, dados, card_id, usuario, criado_em FROM protocolos WHERE numero = $1',
      [parseInt(req.params.numero, 10)]
    );
    if (!rows[0]) return erro(res, 404, 'protocolo não encontrado');
    res.json(rows[0]);
  } catch (e) { erro(res, 500, 'falha ao buscar o protocolo', e.message); }
});

// ---------------------------------------------------------------- CADASTRO

// GET /agentes/:slug — o agente inteiro, com prompt e template. Só admin.
router.get('/:slug', async (req, res) => {
  if (!ehAdmin(req.usuario)) return erro(res, 403, 'somente Tabelião ou Substituta');
  try {
    const a = await dba.obterAgente(req.params.slug);
    if (!a) return erro(res, 404, 'agente não encontrado');
    res.json(a);
  } catch (e) { erro(res, 500, 'falha ao abrir o agente', e.message); }
});

// POST /agentes/:slug — cria ou atualiza. Toda gravação vira uma versão.
router.post('/:slug', async (req, res) => {
  if (!ehAdmin(req.usuario)) return erro(res, 403, 'somente Tabelião ou Substituta');
  try {
    const b = req.body || {};
    if (!b.nome || !b.prompt_sistema) return erro(res, 400, 'nome e prompt_sistema são obrigatórios');
    const salvo = await dba.salvarAgente({ ...b, slug: req.params.slug }, req.usuario.login);
    res.json(salvo);
  } catch (e) { erro(res, 500, 'falha ao salvar o agente', e.message); }
});

// GET /agentes/:slug/versoes — histórico de edições do prompt.
router.get('/:slug/versoes', async (req, res) => {
  if (!ehAdmin(req.usuario)) return erro(res, 403, 'somente Tabelião ou Substituta');
  try {
    res.json(await dba.versoesDoAgente(req.params.slug));
  } catch (e) { erro(res, 500, 'falha ao listar versões', e.message); }
});

module.exports = router;
