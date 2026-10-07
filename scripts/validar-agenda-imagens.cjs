'use strict';
// Validação HTTP + PostgreSQL real, somente no banco local de testes da agenda.
// Preparação: createdb -h 127.0.0.1 -p 55436 -U cn2o_test cn2o_agenda_test
// Execução: node scripts/validar-agenda-imagens.cjs
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const test = require('node:test');
const express = require('express');

const conexao = new URL(process.env.AGENDA_TEST_DATABASE_URL || 'postgresql://cn2o_test@127.0.0.1:55436/cn2o_agenda_test');
if (!['127.0.0.1', 'localhost'].includes(conexao.hostname) || conexao.port !== '55436' || !/^\/cn2o_agenda_test(?:_[a-z0-9]+)?$/.test(conexao.pathname)) {
  throw new Error('Este teste só usa localhost:55436/cn2o_agenda_test; produção não é permitida.');
}
process.env.DATABASE_URL = conexao.href;
process.env.HUB_ADMINS = 'qa.agenda.admin';
const db = require('../db');
const TOKEN_A = randomBytes(24).toString('hex');
const TOKEN_B = randomBytes(24).toString('hex');
const TOKEN_ADMIN = randomBytes(24).toString('hex');
const dia = '2030-01-15';
let servidor, base, verificacoes = 0;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(tipo, dados) {
  const conteudo = Buffer.concat([Buffer.from(tipo), dados]);
  const cabecalho = Buffer.alloc(4), rodape = Buffer.alloc(4);
  cabecalho.writeUInt32BE(dados.length); rodape.writeUInt32BE(crc32(conteudo));
  return Buffer.concat([cabecalho, conteudo, rodape]);
}
function png(cor = [50, 70, 90], preenchimento = 0, largura = 1, altura = 1) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(largura, 0); ihdr.writeUInt32BE(altura, 4); ihdr[8] = 8; ihdr[9] = 2;
  const partes = [Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, ...cor])))];
  if (preenchimento) partes.push(chunk('tEXt', Buffer.concat([Buffer.from('Comment\0'), Buffer.alloc(preenchimento, 32)])));
  partes.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(partes);
}
const PRINT = png(), OUTRO_PRINT = png([80, 40, 70]);
const imagem = (dados = PRINT, mime = 'image/png') => ({ mime, base64: dados.toString('base64') });
const local = (faixa = 7, data = dia) => ({ dia: data, faixa });
const binario = (faixa = 7, data = dia, extra = '') => '/hub/agenda/imagem?dia=' + data + '&faixa=' + faixa + extra;
async function pedir(caminho, token = TOKEN_A, corpo) {
  const headers = { 'X-Auth-Token': token };
  if (corpo !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(base + caminho, { method: corpo === undefined ? 'GET' : 'POST', headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
}
async function json(caminho, token = TOKEN_A, corpo, status = 200) {
  const r = await pedir(caminho, token, corpo); const resultado = await r.json();
  assert.equal(r.status, status, JSON.stringify(resultado));
  return resultado;
}
const salvarTexto = (texto, faixa = 7, token = TOKEN_A) => json('/hub/agenda', token, { ...local(faixa), texto });
const salvarImagem = (conteudo = imagem(), faixa = 7, token = TOKEN_A) => json('/hub/agenda/imagem', token, { ...local(faixa), imagem: conteudo });
async function listar(token = TOKEN_A, extra = '') {
  return (await json('/hub/agenda?de=2030-01-01&ate=2030-02-28' + extra, token)).itens;
}
async function celula(faixa = 7, token = TOKEN_A) { return (await listar(token)).find(item => item.dia === dia && item.faixa === faixa); }
async function confereBytes(esperado = PRINT, faixa = 7, token = TOKEN_A) {
  const r = await pedir(binario(faixa), token);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png');
  assert.match(r.headers.get('cache-control'), /no-store/); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), esperado);
}

test.before(async () => {
  await db.init();
  for (const [login, cargo, token] of [['qa.agenda.a', 'Escrevente', TOKEN_A], ['qa.agenda.b', 'Escrevente', TOKEN_B], ['qa.agenda.admin', 'Tabelião', TOKEN_ADMIN]]) {
    await db.pool.query('INSERT INTO usuarios (login,nome,cargo) VALUES ($1,$1,$2) ON CONFLICT (login) DO NOTHING', [login, cargo]);
    await db.criarSessao(token, login);
  }
  // Reproduz a tabela anterior à anexação. Em repetição, limpa só usuários fictícios.
  await db.pool.query(`CREATE TABLE IF NOT EXISTS hub_agenda (
    login TEXT NOT NULL, dia DATE NOT NULL, faixa SMALLINT NOT NULL, texto TEXT NOT NULL,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(login,dia,faixa))`);
  await db.pool.query("DELETE FROM hub_agenda WHERE login IN ('qa.agenda.a','qa.agenda.b','qa.agenda.admin')");
  await db.pool.query('INSERT INTO hub_agenda(login,dia,faixa,texto) VALUES ($1,$2,23,$3)', ['qa.agenda.a', dia, 'Lembrete anterior à migração']);
  const app = express(); app.use('/hub', require('../hub'));
  servidor = app.listen(0, '127.0.0.1');
  await new Promise(resolve => servidor.once('listening', resolve));
  base = 'http://127.0.0.1:' + servidor.address().port;
});
test.after(async () => {
  if (servidor) await new Promise(resolve => servidor.close(resolve));
  await db.pool.end();
  console.log('Validação da agenda: ' + verificacoes + ' cenários concluídos com PostgreSQL e sessões reais locais.');
});

test('agenda: anexos persistidos e privados, mantendo o texto e a migração', async t => {
  async function caso(nome, fn) { await t.test(nome, async () => { await fn(); verificacoes++; }); }
  await caso('migração aditiva mantém a anotação anterior e inclui metadados vazios', async () => {
    const anterior = await celula(23); assert.equal(anterior.texto, 'Lembrete anterior à migração'); assert.equal(anterior.imagem, null);
  });
  await caso('sessão ausente ou expirada não lê nem altera imagens ou agenda', async () => {
    for (const token of ['', 'invalida']) {
      assert.equal((await pedir('/hub/agenda?de=2030-01-01&ate=2030-01-31', token)).status, 401);
      assert.equal((await pedir(binario(), token)).status, 401);
      assert.equal((await pedir('/hub/agenda/imagem', token, { ...local(), imagem: imagem() })).status, 401);
      assert.equal((await pedir('/hub/agenda', token, { ...local(), texto: 'não salvar' })).status, 401);
    }
  });
  await caso('print com texto é salvo e recuperado byte a byte, sem base64 na listagem', async () => {
    await salvarTexto('Consultar este print amanhã'); await salvarImagem();
    const item = await celula(); assert.equal(item.texto, 'Consultar este print amanhã');
    assert.deepEqual(item.imagem, { mime: 'image/png', bytes: PRINT.length, versao: createHash('sha256').update(PRINT).digest('hex') });
    assert.equal('base64' in item.imagem, false); assert.equal('imagem_dados' in item, false);
    await confereBytes();
  });
  await caso('alterar texto preserva o print e a versão do anexo', async () => {
    const antes = (await celula()).imagem; await salvarTexto('Lembrete revisado');
    assert.deepEqual((await celula()).imagem, antes); await confereBytes();
  });
  await caso('limpar texto conserva o print sozinho', async () => {
    await salvarTexto(''); assert.equal((await celula()).texto, ''); await confereBytes();
  });
  await caso('print sozinho pode receber texto depois', async () => {
    await salvarImagem(imagem(), 8); assert.equal((await celula(8)).texto, '');
    await salvarTexto('Descrição posterior', 8); assert.equal((await celula(8)).texto, 'Descrição posterior'); await confereBytes(PRINT, 8);
  });
  await caso('substituir print preserva texto e muda a versão', async () => {
    await salvarTexto('Texto preservado'); const antes = (await celula()).imagem.versao;
    await salvarImagem(imagem(OUTRO_PRINT)); assert.equal((await celula()).texto, 'Texto preservado');
    assert.notEqual((await celula()).imagem.versao, antes); await confereBytes(OUTRO_PRINT);
  });
  await caso('remover print mantém o texto; binário deixa de existir', async () => {
    await salvarImagem(null); const item = await celula(); assert.equal(item.texto, 'Texto preservado'); assert.equal(item.imagem, null);
    assert.equal((await pedir(binario())).status, 404);
  });
  await caso('remover o último conteúdo apaga apenas a célula, de forma idempotente', async () => {
    await salvarTexto(''); assert.equal(await celula(), undefined);
    await salvarImagem(null); assert.equal(await celula(), undefined);
    await salvarImagem(imagem()); await salvarImagem(null); assert.equal(await celula(), undefined);
  });
  await caso('colega e administrador não veem o print da dona, mesmo forjando login', async () => {
    await salvarTexto('Privado'); await salvarImagem();
    for (const token of [TOKEN_B, TOKEN_ADMIN]) {
      assert.equal((await pedir(binario(7, dia, '&login=qa.agenda.a'), token)).status, 404);
      assert.deepEqual(await listar(token, '&login=qa.agenda.a'), []);
    }
  });
  await caso('login no corpo não permite gravar ou remover o print de outra pessoa', async () => {
    await json('/hub/agenda/imagem', TOKEN_B, { ...local(), login: 'qa.agenda.a', imagem: imagem(OUTRO_PRINT) });
    await confereBytes(PRINT, 7, TOKEN_A); await confereBytes(OUTRO_PRINT, 7, TOKEN_B);
    await json('/hub/agenda/imagem', TOKEN_ADMIN, { ...local(), login: 'qa.agenda.a', imagem: null });
    await confereBytes(PRINT, 7, TOKEN_A);
  });
  await caso('datas, faixas, MIME e conteúdos inválidos são recusados sem perder o print atual', async () => {
    const erros = [
      { ...local(), imagem: imagem(PRINT, 'image/svg+xml') },
      { ...local(), imagem: imagem(PRINT, 'image/jpeg') },
      { ...local(), imagem: imagem(Buffer.from('<svg onload="alert(1)"/>')) },
      { ...local(), imagem: { mime: 'image/png', base64: '????' } },
      { ...local(), imagem: imagem(PRINT.subarray(0, -4)) },
      { ...local(), imagem: imagem(png([1, 2, 3], 0, 4097, 1)) },
      { ...local(), imagem: imagem(png([1, 2, 3], 0, 4000, 4000)) },
      { dia: '2030-02-30', faixa: 7, imagem: imagem() },
      { dia, faixa: 24, imagem: imagem() },
      { ...local(), imagem: 'incorreta' }, { ...local() }
    ];
    for (const corpo of erros) await json('/hub/agenda/imagem', TOKEN_A, corpo, 400);
    await confereBytes();
  });
  await caso('limite de 1 MiB é aceito; 1 byte excedente é recusado', async () => {
    // tEXt adicional válido mantém o arquivo PNG íntegro até o limite exato.
    const limite = png([50, 70, 90], 1024 * 1024 - png().length - 20);
    assert.equal(limite.length, 1024 * 1024); await salvarImagem(imagem(limite), 9); await confereBytes(limite, 9);
    const excessivo = png([50, 70, 90], 1024 * 1024 - png().length - 19);
    await json('/hub/agenda/imagem', TOKEN_A, { ...local(9), imagem: imagem(excessivo) }, 413);
    await confereBytes(limite, 9);
  });
  await caso('payload acima do parser tem erro próprio e não altera o print anterior', async () => {
    const r = await pedir('/hub/agenda/imagem', TOKEN_A, { ...local(), imagem: { mime: 'image/png', base64: 'A'.repeat(4 * 1024 * 1024) } });
    assert.equal(r.status, 413); const b = await r.json(); assert.match(b.erro, /imagem|print|anexo/i); await confereBytes();
  });
  await caso('autosave de texto e upload concorrentes conservam ambos os dados', async () => {
    for (let n = 0; n < 15; n++) {
      await salvarImagem(null, 10); await salvarTexto('', 10);
      await Promise.all([salvarTexto('Concorrência ' + n, 10), salvarImagem(imagem(), 10)]);
      const item = await celula(10); assert.equal(item.texto, 'Concorrência ' + n); assert.ok(item.imagem); await confereBytes(PRINT, 10);
    }
  });
  await caso('limpar texto concorrente com upload não apaga o novo print', async () => {
    for (let n = 0; n < 15; n++) {
      await salvarImagem(null, 11); await salvarTexto('Anterior', 11);
      await Promise.all([salvarTexto('', 11), salvarImagem(imagem(), 11)]);
      const item = await celula(11); assert.equal(item.texto, ''); assert.ok(item.imagem); await confereBytes(PRINT, 11);
    }
  });
  await caso('remover print concorrente com novo texto não perde a anotação', async () => {
    for (let n = 0; n < 15; n++) {
      await salvarTexto('', 12); await salvarImagem(imagem(), 12);
      await Promise.all([salvarImagem(null, 12), salvarTexto('Preservar ' + n, 12)]);
      const item = await celula(12); assert.equal(item.texto, 'Preservar ' + n); assert.equal(item.imagem, null);
    }
  });
  await caso('coluna BYTEA persiste o conteúdo exato após nova conexão e nova sessão', async () => {
    const { Pool } = require('pg'); const pool = new Pool({ connectionString: conexao.href });
    try {
      const r = await pool.query('SELECT imagem_dados, texto FROM hub_agenda WHERE login=$1 AND dia=$2 AND faixa=7', ['qa.agenda.a', dia]);
      assert.deepEqual(r.rows[0].imagem_dados, PRINT); assert.equal(r.rows[0].texto, 'Privado');
    } finally { await pool.end(); }
    const novoToken = randomBytes(24).toString('hex'); await db.criarSessao(novoToken, 'qa.agenda.a');
    await confereBytes(PRINT, 7, novoToken); await db.encerrarSessao(novoToken);
    assert.equal((await pedir(binario(), novoToken)).status, 401);
  });
  await caso('auditoria não contém texto, base64 ou binário dos anexos', async () => {
    const r = await db.pool.query("SELECT detalhe FROM hub_auditoria WHERE login IN ('qa.agenda.a','qa.agenda.b','qa.agenda.admin')");
    const trilha = JSON.stringify(r.rows); assert.doesNotMatch(trilha, /Consultar este print|Descrição posterior|Texto preservado|iVBORw0KGgo|Privado/);
  });
});
