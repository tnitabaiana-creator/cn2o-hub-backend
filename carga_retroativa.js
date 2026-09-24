// carga_retroativa.js — histórico dos quadros no Trello → rastreio dos relatórios.
//
// Puxa as ações dos quadros 00, 01 e 02-* desde uma data (padrão 01/06/2026), grava em
// eventos_trello e reconstrói cada cartão tocado. Pode rodar quantas vezes quiser: a
// chave da ação impede duplicata e a reconstrução é sempre do cartão inteiro. É também
// o que o agendador roda todo dia cedo (últimos 3 dias), para cobrir webhook perdido.
//
// Uso (no servidor, ou local com DATABASE_URL, TRELLO_KEY e TRELLO_TOKEN):
//   npm run carga                          → desde 2026-06-01
//   npm run carga -- --desde 2026-08-01
//   npm run carga -- --quadros id1,id2     → só esses quadros
//   npm run carga -- --reprocessar         → não busca nada: reconstrói todos os cartões
//                                            (depois de mudar categoria, calendário ou escrevente)
// A API devolve até 1000 ações por página, da mais nova para a mais antiga; a próxima
// página pede as anteriores à última recebida (parâmetro before).
'use strict';

const db = require('./db');
const trello = require('./trello');
const rastreio = require('./rastreio');
const cal = require('./horas-uteis');

const POR_PAGINA = 1000;

// 00. Protocolo/Cadastro e 01. TABELIÃO: ids reais como padrão (não são segredo);
// as variáveis mandam, se existirem.
const BOARD_00 = () => process.env.BOARD_00 || '692e0379fa55156e778f27ef';
const BOARD_01 = () => process.env.BOARD_01 || '692e06a94b807c2a1816d992';
const limpar = ids => [...new Set(ids.map(s => String(s || '').trim()).filter(Boolean))];

// sem banco: variáveis + quadros das escreventes da Fase 0 (usado também na conferência
// dos webhooks, em GET /hub/relatorios/status)
function quadrosPadrao() {
  return limpar([BOARD_00(), BOARD_01(), ...String(process.env.BOARDS_ESCREVENTES || '').split(','),
    ...require('./db-relatorios').ESCREVENTES.map(e => e[2])]);
}
// com banco: soma as escreventes cadastradas depois (tabela escreventes)
async function quadrosMonitorados() {
  const r = await db.pool.query('SELECT board_id FROM escreventes WHERE ativo');
  return limpar([...quadrosPadrao(), ...r.rows.map(x => x.board_id)]);
}

// Todas as ações de um quadro desde "desde" (Date), página a página.
async function acoesDoQuadro(boardId, desde, { t = trello.t, log = () => {} } = {}) {
  const todas = [];
  let antes = null;
  for (let pagina = 1; pagina <= 500; pagina++) {
    const qs = [`filter=${rastreio.FILTRO_API}`, `limit=${POR_PAGINA}`, `since=${desde.toISOString()}`,
      'fields=id,type,date,data', 'memberCreator=false', antes ? `before=${antes}` : ''].filter(Boolean).join('&');
    const lote = await t('GET', `/boards/${boardId}/actions?${qs}`);
    if (!Array.isArray(lote) || !lote.length) break;
    todas.push(...lote);
    log(`  quadro ${boardId}: página ${pagina} (${lote.length} ações)`);
    if (lote.length < POR_PAGINA) break;
    antes = lote[lote.length - 1].id;
  }
  return todas;
}

async function carga({ desde = '2026-06-01', quadros, t = trello.t, log = console.log } = {}) {
  const inicio = cal.meiaNoiteLocal(desde);
  const ids = quadros && quadros.length ? quadros : await quadrosMonitorados();
  let lidas = 0, novas = 0;
  const cartoes = new Set();
  for (const boardId of ids) {
    const acoes = await acoesDoQuadro(boardId, inicio, { t, log });
    lidas += acoes.length;
    novas += await rastreio.registrarEventos(acoes, 'carga');
    for (const a of acoes) if (rastreio.relevante(a)) cartoes.add(a.data.card.id);
  }
  log(`${lidas} ações lidas em ${ids.length} quadro(s), ${novas} novas; reconstruindo ${cartoes.size} cartão(ões)…`);
  let n = 0;
  for (const id of cartoes) {
    await rastreio.processarCartao(id);
    if (++n % 200 === 0) log(`  … ${n}/${cartoes.size}`);
  }
  // sobra de processamento interrompido (queda no meio de um webhook)
  const pendentes = await rastreio.reprocessar();
  const semTipo = await db.pool.query(
    `SELECT rotulo, count(*)::int AS n FROM conclusoes WHERE tipo_ato = 'OUTROS' GROUP BY rotulo ORDER BY n DESC LIMIT 20`);
  return { desde, quadros: ids.length, lidas, novas, cartoes: cartoes.size, pendentes,
    rotulos_nao_reconhecidos: semTipo.rows };
}

module.exports = { carga, acoesDoQuadro, quadrosMonitorados, quadrosPadrao };

// ------------------------------------------------------------ linha de comando
if (require.main === module) {
  const args = process.argv.slice(2);
  const valor = nome => { const i = args.indexOf(nome); return i >= 0 ? args[i + 1] : undefined; };
  (async () => {
    await require('./db-relatorios').init();
    if (args.includes('--reprocessar')) {
      const n = await rastreio.reprocessar({ todos: true, log: console.log });
      console.log(`${n} cartão(ões) reconstruído(s).`);
    } else {
      const desde = valor('--desde') || '2026-06-01';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) throw new Error('--desde deve ser AAAA-MM-DD');
      const quadros = valor('--quadros') ? valor('--quadros').split(',').map(s => s.trim()).filter(Boolean) : undefined;
      const r = await carga({ desde, quadros });
      console.log(JSON.stringify(r, null, 2));
      if (r.rotulos_nao_reconhecidos.length) {
        console.log('\nRótulos que viraram OUTROS — acrescente a regra em tipos-ato.js se forem atos conhecidos.');
      }
    }
  })()
    .then(() => db.pool.end())
    .catch(e => { console.error(e); db.pool.end().finally(() => process.exit(1)); });
}
