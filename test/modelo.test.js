'use strict';
// v1.49 — API Claude: cada ação do Hub com o seu modelo e esforço (claude.js PERFIS).
const test = require('node:test');
const assert = require('node:assert/strict');
const claude = require('../claude');

// Cliente falso: guarda o corpo de cada pedido e responde como a API (mensagem final do stream).
function clienteFalso(resposta = {}) {
  const pedidos = [];
  claude._definirCliente({
    messages: {
      stream: corpo => {
        pedidos.push(JSON.parse(JSON.stringify(corpo)));
        return { finalMessage: async () => Object.assign({
          model: corpo.model, stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"ok":true}' }],
          usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        }, typeof resposta === 'function' ? resposta(corpo, pedidos.length) : resposta) };
      }
    }
  });
  return pedidos;
}
test.afterEach(() => claude._definirCliente(null));

test('perfis: a minuta no Opus com esforço alto; descrição, transposição e redator no Sonnet com esforço baixo; produtividade no Haiku', () => {
  const p = t => { const x = claude.perfil(t); return x.modelo + ':' + x.esforco; };
  assert.equal(p('minuta'), 'claude-opus-5-5:high');
  assert.equal(p('minuta_ue'), 'claude-opus-5-5:high');
  assert.equal(p('agente-redigir'), 'claude-opus-5-5:high');
  assert.equal(p('agente-revisar'), 'claude-opus-5-5:medium');
  assert.equal(p('matricula'), 'claude-opus-5-5:medium');
  assert.equal(p('itcmd'), 'claude-sonnet-5-5:high');
  assert.equal(p('qualificacao'), 'claude-sonnet-5-5:medium');
  assert.equal(p('agente-extrair'), 'claude-sonnet-5-5:medium');
  assert.equal(p('agente-executar'), 'claude-sonnet-5-5:medium');
  assert.equal(p('descricao'), 'claude-sonnet-5-5:low');
  assert.equal(p('transpor'), 'claude-sonnet-5-5:low');
  assert.equal(p('redator'), 'claude-sonnet-5-5:low');
  assert.equal(p('produtividade'), 'claude-haiku-5-5:low');
  assert.equal(p('ferramenta-nova'), 'claude-sonnet-5-5:medium');   // sem perfil: o padrão
});

test('IA_PERFIL_<TAREFA> troca modelo e esforço sem deploy; valor inválido é ignorado', () => {
  process.env.IA_PERFIL_MINUTA = 'claude-sonnet-5-5:medium';
  process.env.IA_PERFIL_AGENTE_EXTRAIR = 'gemini-3.8-flash';
  try {
    assert.deepEqual([claude.perfil('minuta').modelo, claude.perfil('minuta').esforco], ['claude-sonnet-5-5', 'medium']);
    assert.equal(claude.perfil('agente-extrair').modelo, 'claude-sonnet-5-5');
    assert.equal(claude.perfil('agente-extrair').esforco, 'medium');
  } finally { delete process.env.IA_PERFIL_MINUTA; delete process.env.IA_PERFIL_AGENTE_EXTRAIR; }
});

test('o pedido leva o modelo e o output_config.effort do perfil; a minuta com cache no prompt grande', async () => {
  const pedidos = clienteFalso({ content: [{ type: 'text', text: 'MINUTA' }] });
  const r = await claude.executar({ agente: { prompt_sistema: 'Prompt-Mestre' }, observacoes: 'ficha', tarefa: 'minuta', codigo: 'C0DE1234' });
  const c = pedidos[0];
  assert.equal(c.model, 'claude-opus-5-5');
  assert.equal(c.output_config.effort, 'high');
  assert.equal(c.max_tokens, 64000);
  assert.deepEqual(c.system[0], { type: 'text', text: 'Prompt-Mestre', cache_control: { type: 'ephemeral' } });
  assert.match(c.system[1].text, /\[C0DE1234\]/);            // o código fica fora do bloco em cache
  assert.equal(c.temperature, undefined);
  assert.equal(r.uso.modelo, 'claude-opus-5-5');
  assert.equal(r.uso.esforco, 'high');

  await claude.executar({ agente: { prompt_sistema: 'Not-Extrator' }, observacoes: 'x', tarefa: 'descricao' });
  assert.equal(pedidos[1].model, 'claude-sonnet-5-5');
  assert.equal(pedidos[1].output_config.effort, 'low');
  assert.equal(pedidos[1].system[0].cache_control, undefined);   // prompt médio: sem cache
});

test('imagem e PDF viram blocos image/document; HEIC fica fora', async () => {
  const pedidos = clienteFalso({ content: [{ type: 'text', text: 'ok' }] });
  await claude.executar({ agente: { prompt_sistema: 'x' }, tarefa: 'qualificacao', arquivos: [
    { mime: 'image/jpeg', base64: 'AAA=' }, { mime: 'application/pdf', base64: 'BBB=' }, { mime: 'image/heic', base64: 'CCC=' }
  ] });
  const blocos = pedidos[0].messages[0].content;
  assert.deepEqual(blocos[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA=' } });
  assert.deepEqual(blocos[1], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBB=' } });
  assert.equal(blocos.length, 3);                                // 2 arquivos + o texto do pedido
  assert.equal(blocos[2].type, 'text');
  assert.equal(claude.ehHeic('image/HEIF'), true);
});

test('esquema JSON: vai em output_config.format; se a API recusar (400), segue sem ele', async () => {
  const esquema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
  const pedidos = [];
  claude._definirCliente({ messages: { stream: corpo => {
    pedidos.push(JSON.parse(JSON.stringify(corpo)));
    return { finalMessage: async () => {
      if (corpo.output_config.format) { const e = new Error('schema too complex'); e.status = 400; throw e; }
      return { model: corpo.model, stop_reason: 'end_turn', content: [{ type: 'text', text: '{"a":"1"}' }], usage: {} };
    } };
  } } });
  const r = await claude.executar({ agente: { prompt_sistema: 'x' }, tarefa: 'transpor', esquema });
  assert.deepEqual(pedidos[0].output_config.format, { type: 'json_schema', schema: esquema });
  assert.equal(pedidos[1].output_config.format, undefined);
  assert.equal(pedidos[1].output_config.effort, 'low');
  assert.equal(r.texto, '{"a":"1"}');
});

test('extração: esquema com um texto por campo + _alertas; com fonte, sem esquema', async () => {
  const pedidos = clienteFalso({ content: [{ type: 'text', text: '{"nome":"ANA","_alertas":[]}' }] });
  const agente = { prompt_sistema: 'x', campos: [{ id: 'nome', tipo: 'texto' }, { id: 'descricao', tipo: 'longo' }] };
  const { dados, uso } = await claude.extrair({ agente, arquivos: [], observacoes: 'z' });
  assert.equal(dados.nome, 'ANA');
  assert.equal(uso.modelo, 'claude-sonnet-5-5');
  const s = pedidos[0].output_config.format.schema;
  assert.deepEqual(s.required, ['nome', 'descricao', '_alertas']);
  assert.equal(s.additionalProperties, false);
});

test('minuta truncada (stop_reason max_tokens) vira erro, nunca texto salvo pela metade', async () => {
  clienteFalso({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'ESCRITURA PÚBLICA DE COMPRA E VEN' }] });
  await assert.rejects(claude.redigir({ agente: { prompt_sistema: 'x' }, dados: {} }), /excedeu o limite de saída/);
});

test('busca na web: agente com usa_busca recebe a ferramenta web_search; pause_turn continua', async () => {
  const pedidos = clienteFalso((corpo, n) => n === 1
    ? { stop_reason: 'pause_turn', content: [{ type: 'text', text: 'pesquisando' }] }
    : { content: [{ type: 'text', text: 'laudo' }], usage: { input_tokens: 10, output_tokens: 10, server_tool_use: { web_search_requests: 2 } } });
  const r = await claude.executar({ agente: { prompt_sistema: 'x', usa_busca: true }, observacoes: 'imóvel' });
  assert.equal(pedidos[0].tools[0].name, 'web_search');
  assert.equal(pedidos.length, 2);
  assert.equal(pedidos[1].messages[1].role, 'assistant');
  assert.equal(r.texto, 'laudo');
  assert.ok(r.uso.custo_usd >= 0.02);                            // 2 buscas × US$ 0,01
});

test('erro do provedor vira recado que o Hub entende (sobrecarga 529, cota 429, tempo)', async () => {
  claude._definirCliente({ messages: { stream: () => ({ finalMessage: async () => { const e = new Error('Overloaded'); e.status = 529; throw e; } }) } });
  await assert.rejects(claude.executar({ agente: { prompt_sistema: 'x' }, observacoes: 'y' }), /529 overloaded/);
  claude._definirCliente({ messages: { stream: () => ({ finalMessage: async () => { const e = new Error('rate_limit_error'); e.status = 429; throw e; } }) } });
  await assert.rejects(claude.executar({ agente: { prompt_sistema: 'x' }, observacoes: 'y' }), /\b429\b/);
  class APIConnectionTimeoutError extends Error {}
  claude._definirCliente({ messages: { stream: () => ({ finalMessage: async () => { throw new APIConnectionTimeoutError('timeout'); } }) } });
  await assert.rejects(claude.executar({ agente: { prompt_sistema: 'x' }, observacoes: 'y' }), /não respondeu em/);
});

test('custo: tabela Claude, com gravação e leitura de cache', () => {
  const { custoUsd } = claude;
  assert.equal(custoUsd('claude-opus-5-5', 1e6, 1e6), 24);
  assert.equal(custoUsd('claude-sonnet-5-5', 1e6, 1e6), 12);
  assert.ok(Math.abs(custoUsd('claude-haiku-5-5', 1e6 / 20, 1e6 / 20) - 0.03) < 1e-9);   // 50 mil: tabela curta
  assert.equal(custoUsd('claude-opus-5-5', 0, 0, 1e6, 0), 5);                 // gravar cache: 1,25×
  assert.ok(Math.abs(custoUsd('claude-opus-5-5', 0, 0, 0, 1e6) - 0.2) < 1e-9); // reler cache: 5%
  assert.equal(custoUsd('modelo-desconhecido', 1e6, 0), 4);                   // sem preço: o do Opus
});

test('nenhum código chama mais o Gemini', () => {
  const fs = require('fs'), path = require('path');
  const raiz = path.join(__dirname, '..');
  assert.equal(fs.existsSync(path.join(raiz, 'gemini.js')), false);
  for (const n of ['claude.js', 'hub.js', 'agentes.js', 'produtividade.js']) {
    const s = fs.readFileSync(path.join(raiz, n), 'utf8');
    assert.doesNotMatch(s, /generativelanguage\.googleapis|require\('\.\/gemini'\)|GEMINI_API_KEY/, n);
  }
});
