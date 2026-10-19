'use strict';
// v1.51 — triagem pelo Haiku: sinais sem dado pessoal, nota por regras, travas, modos sombra/ativa.
const test = require('node:test');
const assert = require('node:assert/strict');
const claude = require('../claude');
const dba = require('../db-agentes');
const T = require('../triagem');

// grava em memória o que iria ao banco
const gravados = { triagem: [], consumo: [] };
const original = { registrarTriagem: dba.registrarTriagem, registrarConsumo: dba.registrarConsumo };
test.before(() => {
  dba.registrarTriagem = async t => { gravados.triagem.push(t); };
  dba.registrarConsumo = async c => { gravados.consumo.push(c); };
});
test.after(() => { Object.assign(dba, original); claude._definirCliente(null); });
test.beforeEach(() => { gravados.triagem.length = 0; gravados.consumo.length = 0; delete process.env.IA_TRIAGEM; delete process.env.IA_PERFIL_MINUTA; });
const espera = () => new Promise(r => setTimeout(r, 10));

// cliente falso: a triagem (Haiku) responde `haiku`; a análise principal responde `principal(corpo)`
function cliente({ haiku = { score: 50, degrau: 5, confianca: 'alta', motivo: 'meio-termo' }, principal } = {}) {
  const pedidos = [];
  claude._definirCliente({ messages: { stream: corpo => {
    pedidos.push(JSON.parse(JSON.stringify(corpo)));
    return { finalMessage: async () => {
      const ehTriagem = corpo.model === claude.HAIKU && corpo.output_config.format && corpo.output_config.format.schema.required.includes('degrau');
      if (ehTriagem && haiku instanceof Error) throw haiku;
      const texto = ehTriagem ? JSON.stringify(haiku) : (principal ? principal(corpo, pedidos) : 'Estado: PRONTA\nMinuta.');
      return { model: corpo.model, stop_reason: 'end_turn', content: [{ type: 'text', text: texto }], usage: { input_tokens: 1000, output_tokens: 500 } };
    } };
  } } });
  return pedidos;
}

const CV_SIMPLES = { tarefa: 'minuta', texto: 'ATO: CV\nVendedor: ANA MARIA SOUZA, CPF 123.456.789-09\nComprador: JOÃO LIMA, CPF 987.654.321-00\nImóvel urbano, casa.', arquivos: [{ mime: 'application/pdf', base64: 'AAAA' }] };
const INVENTARIO = { tarefa: 'minuta', texto: 'ATO: INVENTARIO cumulativo\nEspólio de JOSÉ, falecido; herdeira menor de idade sob tutela; imóvel rural CCIR e SIGEF; R.1 R.2 R.3 AV.4 AV.5 R.6 penhora; hipoteca; usufruto; cessão de direitos.\nCPF 111.111.111-11 222.222.222-22 333.333.333-33 444.444.444-44 555.555.555-55',
  arquivos: Array.from({ length: 10 }, () => ({ mime: 'application/pdf', base64: 'AAAA' })), ocrResumo: { ativo: true, paginas: 30, palavras_lidas: 1000, palavras_incertas: 120 } };

test('sinais: só contagens e marcas — nenhum nome, CPF ou trecho de documento', () => {
  const s = T.sinaisDoPedido(CV_SIMPLES);
  const json = JSON.stringify(s);
  assert.doesNotMatch(json, /ANA|JOÃO|123\.456|12345678909|casa/);
  assert.equal(s.cpfs, 2);
  assert.equal(s.ato, 'cv');
  assert.equal(s.arquivos, 1);
  const i = T.sinaisDoPedido(INVENTARIO);
  assert.equal(i.cpfs, 5);
  assert.ok(i.registros_matricula >= 6);
  assert.deepEqual(i.onus.sort(), ['hipoteca', 'penhora', 'usufruto']);
  assert.equal(i.marcas.rural && i.marcas.menor_incapaz && i.marcas.espolio && i.marcas.cessao, true);
  assert.equal(i.ocr_incerto_pct, 12);
});

test('nota por regras: compra e venda simples < inventário rural com ônus e menor', () => {
  const a = T.notaPorRegras(T.sinaisDoPedido(CV_SIMPLES)).nota;
  const b = T.notaPorRegras(T.sinaisDoPedido(INVENTARIO)).nota;
  assert.ok(a < 25, 'simples: ' + a);
  assert.ok(b > 75, 'complexo: ' + b);
});

test('travas: minuta nunca abaixo de Sonnet médio; qualificação nunca acima de Sonnet alto', () => {
  assert.equal(T.degrauDaNota(0, T.FAIXAS.minuta), 4);
  assert.equal(T.degrauDaNota(100, T.FAIXAS.minuta), 7);
  assert.equal(T.degrauDaNota(100, T.FAIXAS.qualificacao), 5);
  assert.deepEqual(T.perfilDoDegrau(4), { modelo: 'claude-sonnet-5-5', esforco: 'medium' });
  assert.equal(T.FAIXAS.transpor, undefined);   // fora do escopo: perfil fixo
});

test('casos claros: as regras decidem sem chamar o Haiku', async () => {
  const pedidos = cliente();
  const r = await T.decidir({ tarefa: 'minuta', sinais: T.sinaisDoPedido(CV_SIMPLES) });
  assert.equal(r.origem, 'regra');
  assert.equal(r.degrau, 4);
  assert.equal(pedidos.length, 0);
  const c = await T.decidir({ tarefa: 'minuta', sinais: T.sinaisDoPedido(INVENTARIO) });
  assert.equal(c.degrau, 7);
});

test('faixa do meio: o Haiku decide com esquema JSON e só os sinais; confiança baixa sobe um degrau', async () => {
  const meio = T.sinaisDoPedido({ tarefa: 'minuta', texto: 'ATO: DOACAO\nCPF 111.111.111-11 222.222.222-22 333.333.333-33\nusufruto; R.1 R.2 R.3', arquivos: Array.from({ length: 5 }, () => ({ mime: 'image/jpeg', base64: 'AAAA' })) });
  const nota = T.notaPorRegras(meio).nota;
  assert.ok(nota >= 25 && nota <= 75, 'nota do meio: ' + nota);
  let pedidos = cliente({ haiku: { score: 55, degrau: 5, confianca: 'alta', motivo: 'doação com usufruto' } });
  let r = await T.decidir({ tarefa: 'minuta', sinais: meio, codigo: 'ABCD1234' });
  assert.equal(r.origem, 'haiku');
  assert.equal(r.degrau, 5);
  assert.equal(pedidos[0].model, 'claude-haiku-5-5');
  assert.equal(pedidos[0].output_config.effort, 'low');
  assert.deepEqual(pedidos[0].output_config.format.schema.properties.degrau.enum, [4, 5, 6, 7]);
  assert.doesNotMatch(JSON.stringify(pedidos[0].messages), /111\.111/);   // nenhum CPF vai ao Haiku
  pedidos = cliente({ haiku: { score: 55, degrau: 5, confianca: 'baixa', motivo: 'dúvida' } });
  r = await T.decidir({ tarefa: 'minuta', sinais: meio });
  assert.equal(r.degrau, 6);
});

test('falha do Haiku: origem "falha", sem degrau — vale o perfil fixo', async () => {
  cliente({ haiku: Object.assign(new Error('Overloaded'), { status: 529 }) });
  const meio = T.sinaisDoPedido({ tarefa: 'minuta', texto: 'ATO: DOACAO\nCPF 111.111.111-11 222.222.222-22 333.333.333-33\nusufruto; R.1 R.2 R.3', arquivos: Array.from({ length: 5 }, () => ({ mime: 'image/jpeg', base64: 'AAAA' })) });
  const r = await T.decidir({ tarefa: 'minuta', sinais: meio });
  assert.equal(r.origem, 'falha');
  assert.equal(r.degrau, null);
});

test('modo sombra (padrão): a análise usa o perfil fixo e a decisão é gravada', async () => {
  const pedidos = cliente();
  const r = await T.comTriagem({ tarefa: 'minuta', login: 'lara', sinais: T.sinaisDoPedido(CV_SIMPLES),
    chamar: perfil => claude.executar({ agente: { prompt_sistema: 'x' }, observacoes: 'y', tarefa: 'minuta', perfil }),
    classificar: resp => T.estadoDaMinuta(resp.texto) });
  await espera();
  assert.equal(pedidos[0].model, 'claude-opus-5-5');            // perfil fixo
  assert.equal(pedidos[0].output_config.effort, 'high');
  assert.equal(r.uso.modelo, 'claude-opus-5-5');
  const g = gravados.triagem[0];
  assert.equal(g.modo, 'sombra');
  assert.equal(g.degrau_sugerido, 4);
  assert.equal(g.degrau_usado, 7);
  assert.equal(g.resultado, 'pronta');
  assert.ok(g.custo_estimado_usd < g.custo_real_usd);            // Sonnet sairia mais barato
});

test('modo ativa: a análise usa o degrau escolhido', async () => {
  process.env.IA_TRIAGEM = 'ativa';
  const pedidos = cliente();
  await T.comTriagem({ tarefa: 'minuta', login: 'lara', sinais: T.sinaisDoPedido(CV_SIMPLES),
    chamar: perfil => claude.executar({ agente: { prompt_sistema: 'x' }, observacoes: 'y', tarefa: 'minuta', perfil }) });
  await espera();
  assert.equal(pedidos[0].model, 'claude-sonnet-5-5');
  assert.equal(pedidos[0].output_config.effort, 'medium');
  assert.equal(gravados.triagem[0].degrau_usado, 4);
});

test('modo ativa: JSON inválido refaz um degrau acima, uma vez só', async () => {
  process.env.IA_TRIAGEM = 'ativa';
  const pedidos = cliente({ principal: (c, todos) => todos.length === 1 ? 'sem json' : '{"ok":true}' });
  const r = await T.comTriagem({ tarefa: 'itcmd', login: 'lara', sinais: T.sinaisDoPedido({ tarefa: 'itcmd', texto: 'ATO: X', arquivos: [] }),
    chamar: perfil => claude.executar({ agente: { prompt_sistema: 'x' }, observacoes: 'y', tarefa: 'itcmd', perfil }),
    classificar: resp => /\{/.test(resp.texto) ? 'ok' : 'json_invalido' });
  await espera();
  assert.equal(pedidos.length, 2);
  assert.deepEqual([pedidos[0].model, pedidos[0].output_config.effort], ['claude-sonnet-5-5', 'medium']);   // degrau 4
  assert.deepEqual([pedidos[1].model, pedidos[1].output_config.effort], ['claude-sonnet-5-5', 'high']);     // degrau 5
  assert.equal(r.texto, '{"ok":true}');
  assert.equal(gravados.consumo.filter(c => c.etapa === 'tentativa').length, 1);   // a tentativa descartada também custou
});

test('IA_PERFIL_<TAREFA> fixado vence a triagem; "desligada" volta à v1.49', async () => {
  process.env.IA_TRIAGEM = 'ativa';
  process.env.IA_PERFIL_MINUTA = 'claude-opus-5-5:medium';
  let pedidos = cliente();
  await T.comTriagem({ tarefa: 'minuta', login: 'x', sinais: T.sinaisDoPedido(CV_SIMPLES),
    chamar: perfil => claude.executar({ agente: { prompt_sistema: 'x' }, observacoes: 'y', tarefa: 'minuta', perfil }) });
  assert.deepEqual([pedidos[0].model, pedidos[0].output_config.effort], ['claude-opus-5-5', 'medium']);
  assert.equal(gravados.triagem.length, 0);
  delete process.env.IA_PERFIL_MINUTA;
  process.env.IA_TRIAGEM = 'desligada';
  pedidos = cliente();
  await T.comTriagem({ tarefa: 'minuta', login: 'x', sinais: null,
    chamar: perfil => claude.executar({ agente: { prompt_sistema: 'x' }, observacoes: 'y', tarefa: 'minuta', perfil }) });
  assert.equal(pedidos[0].model, 'claude-opus-5-5');
  assert.equal(gravados.triagem.length, 0);
});

test('estado da minuta para a calibração', () => {
  assert.equal(T.estadoDaMinuta('DECISÃO\n- Estado: PRELIMINAR\n===MINUTA_COPIAVEL==='), 'preliminar');
  assert.equal(T.estadoDaMinuta('Estado: BLOQUEADA'), 'bloqueada');
  assert.equal(T.estadoDaMinuta('sem envelope'), 'ok');
});
