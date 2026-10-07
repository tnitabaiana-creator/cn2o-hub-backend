'use strict';
// HTTP + PostgreSQL reais, exclusivamente no banco local fictício de QA.
// createdb -h 127.0.0.1 -p 55436 -U cn2o_test cn2o_itcmd_test
// node scripts/validar-itcmd-arquivo.cjs
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const test = require('node:test');
const express = require('express');
const conexao = new URL(process.env.ITCMD_TEST_DATABASE_URL || 'postgresql://cn2o_test@127.0.0.1:55436/cn2o_itcmd_test');
if (!['localhost', '127.0.0.1'].includes(conexao.hostname) || conexao.port !== '55436' || !/^\/cn2o_itcmd_test(?:_[a-z0-9]+)?$/.test(conexao.pathname)) {
  throw new Error('O teste só permite localhost:55436/cn2o_itcmd_test. Não usa produção.');
}
process.env.DATABASE_URL = conexao.href;
process.env.HUB_ADMINS = 'qa.itcmd.admin';
const db = require('../db');
const prefixo = 'QA-' + randomUUID().slice(0, 8);
const usuarios = { a: prefixo + '.a', b: prefixo + '.b', admin: 'qa.itcmd.admin' };
const tokens = Object.fromEntries(Object.keys(usuarios).map(chave => [chave, randomBytes(24).toString('hex')]));
let arquivo, servidor, base, principal, versaoAtual = 1, verificacoes = 0;

function pdf(texto, tamanho) {
  const corpo = 'BT /F1 12 Tf 30 760 Td (' + texto.replace(/[()\\]/g, '') + ') Tj ET';
  const objetos = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(corpo) + ' >>\nstream\n' + corpo + '\nendstream'
  ];
  function construir(padding) {
    let saida = '%PDF-1.4\n', posicoes = [0];
    objetos.forEach((obj, i) => { posicoes.push(Buffer.byteLength(saida)); saida += (i + 1) + ' 0 obj\n' + obj + '\nendobj\n'; });
    if (padding) saida += '%' + ' '.repeat(padding - 2) + '\n';
    const xref = Buffer.byteLength(saida);
    saida += 'xref\n0 6\n0000000000 65535 f \n' + posicoes.slice(1).map(p => String(p).padStart(10, '0') + ' 00000 n \n').join('');
    saida += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    return Buffer.from(saida);
  }
  const pequeno = construir(0); if (!tamanho) return pequeno;
  let padding = tamanho - pequeno.length;
  for (let i = 0; i < 4; i++) { const candidato = construir(padding); if (candidato.length === tamanho) return candidato; padding += tamanho - candidato.length; }
  throw new Error('Não foi possível dimensionar o PDF fictício.');
}
const PDF_V1 = pdf('Orcamento ficticio versao 1'), PDF_V2 = pdf('Orcamento ficticio versao 2');
const hash = dados => createHash('sha256').update(dados).digest('hex');
const documento = (dados = PDF_V1, tipo = 'orcamento', nome = 'orcamento.pdf') => ({ tipo, nome, mime: 'application/pdf', base64: dados.toString('base64') });
function estado(modo = 'inventario', revisao = 1) {
  return { modo, inv: [{ falecido: 'Pessoa ficticia', bens: [{ descricao: 'Bem ficticio', valor: 100000 * revisao }], herdeiros: [] }], doa: { doador: 'Pessoa ficticia' }, qa_revisao: revisao };
}
function pedido(alteracoes = {}) {
  return { titulo: prefixo + ' inventario', protocolo: prefixo, estado: estado(), versao_base: 0, operacao_id: randomUUID(), documentos: [documento()], ...alteracoes };
}
async function requisitar(caminho, token = tokens.a, corpo) {
  const headers = { 'X-Auth-Token': token };
  if (corpo !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(base + caminho, { headers, method: corpo === undefined ? 'GET' : 'POST', body: corpo === undefined ? undefined : JSON.stringify(corpo) });
}
async function json(caminho, corpo, status = 200, token = tokens.a) {
  const r = await requisitar(caminho, token, corpo); const valor = await r.json();
  assert.equal(r.status, status, JSON.stringify(valor)); return valor;
}
const salvar = (corpo, status = 200, token = tokens.a) => json('/trabalhos', corpo, status, token);
const detalhe = (id = principal.id, token = tokens.a) => json('/trabalhos/' + id, undefined, 200, token);
const versao = (n, id = principal.id, token = tokens.a) => json('/trabalhos/' + id + '/versoes/' + n, undefined, 200, token);
async function conferirPdf(doc, esperado, token = tokens.a) {
  assert.equal(doc.sha256, hash(esperado)); assert.equal(doc.bytes, esperado.length);
  const r = await requisitar('/documentos/' + doc.id, token);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('cache-control'), /no-store|private/); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const bytes = Buffer.from(await r.arrayBuffer()); assert.equal(hash(bytes), hash(esperado)); assert.deepEqual(bytes, esperado);
}
async function subir() {
  const app = express();
  app.use('/hub/itcmd', arquivo.createRouter({ pool: db.pool, session: db.sessaoValida, ehAdmin: u => u.login === usuarios.admin }));
  servidor = app.listen(0, '127.0.0.1'); await new Promise(resolve => servidor.once('listening', resolve));
  base = 'http://127.0.0.1:' + servidor.address().port + '/hub/itcmd';
}
async function encerrar() { if (servidor) await new Promise(resolve => servidor.close(resolve)); servidor = null; }

test.before(async () => {
  await db.init();
  for (const chave of Object.keys(usuarios)) {
    const login = usuarios[chave], cargo = chave === 'admin' ? 'Tabelião' : 'Escrevente';
    await db.pool.query('INSERT INTO usuarios(login,nome,cargo) VALUES($1,$1,$2) ON CONFLICT(login) DO NOTHING', [login, cargo]);
    await db.criarSessao(tokens[chave], login);
  }
  await db.pool.query('CREATE TABLE IF NOT EXISTS qa_itcmd_sentinela(id TEXT PRIMARY KEY, valor TEXT NOT NULL)');
  await db.pool.query('INSERT INTO qa_itcmd_sentinela(id,valor) VALUES($1,$2)', [prefixo, 'Outros dados permanecem intactos']);
  arquivo = require('../itcmd-arquivo'); await subir();
});
test.after(async () => {
  await encerrar(); await db.pool.end();
  console.log('Arquivo ITCMD: ' + verificacoes + ' cenários concluídos com HTTP, sessões e PostgreSQL locais reais.');
});

test('arquivo ITCMD: versões e documentos persistentes com controle de concorrência e acesso', async t => {
  async function caso(nome, fn) { await t.test(nome, async () => { await fn(); verificacoes++; }); }
  await caso('sem sessão não consulta nem grava arquivos', async () => {
    for (const token of ['', 'sessao-invalida']) {
      assert.equal((await requisitar('/trabalhos', token)).status, 401);
      assert.equal((await requisitar('/trabalhos', token, pedido())).status, 401);
      assert.equal((await requisitar('/documentos/' + randomUUID(), token)).status, 401);
    }
  });
  await caso('salva estado e PDF atomicamente com hash exato', async () => {
    principal = await salvar(pedido()); assert.ok(principal.id); assert.equal(principal.versao, 1);
    const salvo = await detalhe(); assert.deepEqual(salvo.estado, estado()); assert.equal(salvo.versao, 1);
    assert.equal(salvo.documentos.length, 1); await conferirPdf(salvo.documentos[0], PDF_V1);
  });
  await caso('reinicializar router e schema mantém estado e PDF existentes', async () => {
    await encerrar();
    const { Pool } = require('pg'); const novaConexao = new Pool({ connectionString: conexao.href });
    try { await require('../itcmd-arquivo-db').init(novaConexao); } finally { await novaConexao.end(); }
    await subir(); const salvo = await detalhe();
    assert.deepEqual(salvo.estado, estado()); await conferirPdf(salvo.documentos[0], PDF_V1);
    const r = await db.pool.query('SELECT valor FROM qa_itcmd_sentinela WHERE id=$1', [prefixo]);
    assert.equal(r.rows[0].valor, 'Outros dados permanecem intactos');
  });
  await caso('editar cria nova versão e preserva snapshot e PDF históricos', async () => {
    await salvar(pedido({ id: principal.id, versao_base: 1, estado: estado('inventario', 2), documentos: [documento(PDF_V2)] }));
    versaoAtual = 2; const novo = await detalhe(); assert.equal(novo.versao, 2); assert.deepEqual(novo.estado, estado('inventario', 2));
    await conferirPdf(novo.documentos[0], PDF_V2);
    const antigo = await versao(1); assert.deepEqual(antigo.estado, estado()); await conferirPdf(antigo.documentos[0], PDF_V1);
    assert.ok(novo.versoes.some(v => v.versao === 1)); assert.ok(novo.versoes.some(v => v.versao === 2));
  });
  await caso('terceiro não acessa trabalho, histórico nem documento; administrador pode consultar', async () => {
    const salvo = await detalhe();
    for (const caminho of ['/trabalhos/' + principal.id, '/trabalhos/' + principal.id + '/versoes/1', '/documentos/' + salvo.documentos[0].id]) {
      assert.equal((await requisitar(caminho, tokens.b)).status, 404);
      assert.equal((await requisitar(caminho, tokens.admin)).status, 200);
    }
    const lista = await json('/trabalhos?protocolo=' + encodeURIComponent(prefixo), undefined, 200, tokens.b); assert.equal(lista.itens.length, 0);
    const admin = await detalhe(principal.id, tokens.admin); await conferirPdf(admin.documentos[0], PDF_V2, tokens.admin);
  });
  await caso('forjar login/criado_por não atribui propriedade nem permite editar outro trabalho', async () => {
    const proprio = await salvar(pedido({ criado_por: usuarios.a, login: usuarios.a, titulo: prefixo + ' proprietário B' }), 200, tokens.b);
    assert.equal((await detalhe(proprio.id, tokens.b)).criado_por, usuarios.b);
    assert.equal((await requisitar('/trabalhos/' + proprio.id, tokens.a)).status, 404);
    await salvar(pedido({ id: principal.id, versao_base: versaoAtual, login: usuarios.a }), 404, tokens.b);
  });
  await caso('conflito de versão recusa gravação e mantém estado/PDF atuais', async () => {
    await salvar(pedido({ id: principal.id, versao_base: 1, estado: estado('inventario', 8) }), 409);
    const atual = await detalhe(); assert.equal(atual.versao, versaoAtual); assert.deepEqual(atual.estado, estado('inventario', 2)); await conferirPdf(atual.documentos[0], PDF_V2);
  });
  await caso('duas edições concorrentes da mesma versão produzem só um vencedor', async () => {
    const antes = versaoAtual;
    const corpos = [3, 4].map(n => pedido({ id: principal.id, versao_base: antes, estado: estado('inventario', n), documentos: [] }));
    const respostas = await Promise.all(corpos.map(corpo => requisitar('/trabalhos', tokens.a, corpo)));
    assert.deepEqual(respostas.map(r => r.status).sort(), [200, 409]);
    const vencedor = respostas.findIndex(r => r.status === 200); const atual = await detalhe();
    versaoAtual++; assert.equal(atual.versao, versaoAtual); assert.deepEqual(atual.estado, corpos[vencedor].estado);
    assert.equal(atual.documentos.length, 0, 'nova versão sem PDF não mostra orçamento antigo como atual');
    await conferirPdf((await versao(1)).documentos[0], PDF_V1);
  });
  await caso('repetir operação idêntica não duplica versão ou documento, mesmo depois de outra edição', async () => {
    const corpo = pedido({ id: principal.id, versao_base: versaoAtual, documentos: [documento(PDF_V2)] });
    const primeiro = await salvar(corpo); versaoAtual++; const repetido = await salvar(corpo); assert.deepEqual(repetido, primeiro);
    await salvar(pedido({ id: principal.id, versao_base: versaoAtual, documentos: [] })); versaoAtual++;
    const tardio = await salvar(corpo); assert.deepEqual(tardio, primeiro); assert.equal((await detalhe()).versao, versaoAtual);
    const salvo = await versao(primeiro.versao); assert.equal(salvo.documentos.length, 1); await conferirPdf(salvo.documentos[0], PDF_V2);
  });
  await caso('mesmo ID de operação com conteúdo diferente é recusado', async () => {
    const corpo = pedido({ documentos: [] }); const primeiro = await salvar(corpo);
    await salvar({ ...corpo, titulo: corpo.titulo + ' alterado' }, 409);
    assert.equal((await detalhe(primeiro.id)).versao, 1);
  });
  await caso('envio concorrente da mesma operação não cria trabalhos duplicados', async () => {
    const corpo = pedido(); const respostas = await Promise.all([salvar(corpo), salvar(corpo)]);
    assert.equal(respostas[0].id, respostas[1].id); assert.equal(respostas[0].versao, 1); assert.equal(respostas[1].versao, 1);
    const salvo = await detalhe(respostas[0].id); assert.equal(salvo.versoes.length, 1); assert.equal(salvo.documentos.length, 1);
  });
  await caso('identificador de operação não permite recuperar arquivo de outra pessoa', async () => {
    const corpo = pedido(); const dona = await salvar(corpo); const colega = await salvar(corpo, 200, tokens.b);
    assert.notEqual(dona.id, colega.id); assert.equal((await detalhe(colega.id, tokens.b)).criado_por, usuarios.b);
    assert.equal((await requisitar('/trabalhos/' + dona.id, tokens.b)).status, 404);
  });
  await caso('inventário, cumulativo e doação podem ser reabertos sem PDF', async () => {
    for (const modo of ['inventario', 'cumulativo', 'doacao']) {
      const salvo = await salvar(pedido({ estado: estado(modo), documentos: [], titulo: prefixo + ' ' + modo }));
      assert.deepEqual((await detalhe(salvo.id)).estado, estado(modo));
    }
  });
  await caso('grupos separam inventário e cumulativo de doação, sem expor outro usuário', async () => {
    const ids = {};
    for (const modo of ['inventario', 'cumulativo', 'doacao']) ids[modo] = (await salvar(pedido({ estado: estado(modo), documentos: [], titulo: prefixo + ' GRUPOS ' + modo }))).id;
    for (const grupo of ['inventario', 'doacao']) {
      const r = await json('/trabalhos?busca=' + encodeURIComponent(prefixo + ' GRUPOS') + '&grupo=' + grupo);
      assert.equal(r.itens.length, grupo === 'inventario' ? 2 : 1);
      assert.deepEqual(r.itens.map(i => i.modo).sort(), grupo === 'inventario' ? ['cumulativo', 'inventario'] : ['doacao']);
      assert.ok(r.itens.every(i => Object.values(ids).includes(i.id)));
      const outra = await json('/trabalhos?busca=' + encodeURIComponent(prefixo + ' GRUPOS') + '&grupo=' + grupo, undefined, 200, tokens.b); assert.equal(outra.total, 0);
    }
    await json('/trabalhos?grupo=desconhecido', undefined, 400);
  });
  await caso('busca trata curingas literalmente e lista apenas metadados leves', async () => {
    const titulo = prefixo + ' Nome_% literal';
    const salvo = await salvar(pedido({ titulo }));
    await salvar(pedido({ titulo: prefixo + ' Nome_AB parecido', documentos: [] }));
    const r = await json('/trabalhos?busca=' + encodeURIComponent(prefixo + ' Nome_%'));
    assert.equal(r.total, 1); assert.equal(r.itens[0].id, salvo.id); assert.equal('estado' in r.itens[0], false);
    assert.equal('base64' in r.itens[0].documentos[0], false); assert.equal('dados' in r.itens[0].documentos[0], false);
  });
  await caso('paginação limita a 25 itens e rejeita páginas inválidas', async () => {
    for (let i = 0; i < 28; i++) await salvar(pedido({ titulo: prefixo + ' PAGINA ' + i, documentos: [] }));
    const filtro = '/trabalhos?busca=' + encodeURIComponent(prefixo + ' PAGINA');
    const primeira = await json(filtro + '&pagina=1'); const segunda = await json(filtro + '&pagina=2');
    assert.equal(primeira.total, 28); assert.equal(primeira.itens.length, 25); assert.equal(segunda.itens.length, 3);
    assert.equal(new Set([...primeira.itens, ...segunda.itens].map(i => i.id)).size, 28);
    for (const valor of ['0', '-1', '1.5', 'abc', '9007199254740993']) await json(filtro + '&pagina=' + valor, undefined, 400);
  });
  await caso('falha SQL ao gravar o segundo PDF desfaz trabalho, versão e primeiro PDF', async () => {
    const nomeFalha = prefixo + '-falha.pdf'; const id = randomUUID();
    await db.pool.query(`CREATE OR REPLACE FUNCTION qa_itcmd_falhar_documento() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.nome = '${nomeFalha}' THEN RAISE EXCEPTION 'falha ficticia para QA rollback'; END IF; RETURN NEW; END $$`);
    await db.pool.query('CREATE TRIGGER qa_itcmd_rollback BEFORE INSERT ON itcmd_documentos FOR EACH ROW EXECUTE FUNCTION qa_itcmd_falhar_documento()');
    try {
      const documentos = [documento(PDF_V1), documento(PDF_V2, 'declaracao_causa_mortis', nomeFalha)];
      await salvar(pedido({ id, documentos }), 503);
      for (const [tabela, campo] of [['itcmd_trabalhos', 'id'], ['itcmd_trabalho_versoes', 'trabalho_id'], ['itcmd_documentos', 'trabalho_id']]) {
        const r = await db.pool.query('SELECT count(*) AS total FROM ' + tabela + ' WHERE ' + campo + '=$1', [id]); assert.equal(Number(r.rows[0].total), 0);
      }
      const antes = await detalhe();
      await salvar(pedido({ id: principal.id, versao_base: versaoAtual, documentos }), 503);
      const depois = await detalhe(); assert.equal(depois.versao, antes.versao); assert.deepEqual(depois.estado, antes.estado); assert.deepEqual(depois.versoes, antes.versoes);
    } finally { await db.pool.query('DROP TRIGGER qa_itcmd_rollback ON itcmd_documentos'); await db.pool.query('DROP FUNCTION qa_itcmd_falhar_documento()'); }
  });
  await caso('PDF inválido, estado inválido e campos quebrados não criam trabalho parcial', async () => {
    const antes = (await json('/trabalhos')).total;
    const invalidos = [
      pedido({ documentos: [documento(Buffer.from('<html>Não é PDF</html>'))] }),
      pedido({ documentos: [{ ...documento(), mime: 'image/png' }] }),
      pedido({ documentos: [{ ...documento(), base64: '????' }] }),
      pedido({ estado: 'invalido' }), pedido({ estado: estado('impossivel') }),
      pedido({ operacao_id: 'nao-e-uuid' }), pedido({ versao_base: -1 }), pedido({ titulo: '' })
    ];
    for (const corpo of invalidos) await salvar(corpo, 400);
    assert.equal((await json('/trabalhos')).total, antes);
  });
  await caso('PDF de 5 MiB é persistido sem corrupção e 1 byte excedente é recusado', async () => {
    const limite = pdf('Limite PDF ficticio', 5 * 1024 * 1024);
    const salvo = await salvar(pedido({ documentos: [documento(limite)] })); await conferirPdf((await detalhe(salvo.id)).documentos[0], limite);
    const antes = (await json('/trabalhos')).total;
    await salvar(pedido({ documentos: [documento(pdf('Excesso ficticio', 5 * 1024 * 1024 + 1))] }), 413);
    assert.equal((await json('/trabalhos')).total, antes);
  });
  await caso('estado acima de 1 MiB e PDFs acima de 15 MiB são recusados atomicamente', async () => {
    const antes = (await json('/trabalhos')).total;
    await salvar(pedido({ estado: { ...estado(), excesso: 'x'.repeat(1024 * 1024) }, documentos: [] }), 413);
    const grande = pdf('Total excessivo ficticio', 4 * 1024 * 1024);
    await salvar(pedido({ documentos: ['orcamento', 'declaracao_causa_mortis', 'declaracao_inter_vivos', 'guia_itcmd'].map((tipo, i) => documento(grande, tipo, 'documento-' + i + '.pdf')) }), 413);
    assert.equal((await json('/trabalhos')).total, antes);
  });
  await caso('limites simultâneos de 1 MiB de estado e 15 MiB de PDFs são aceitos integralmente', async () => {
    const noLimite = { ...estado(), preenchimento: '' };
    noLimite.preenchimento = 'x'.repeat(1024 * 1024 - Buffer.byteLength(JSON.stringify(noLimite)));
    assert.equal(Buffer.byteLength(JSON.stringify(noLimite)), 1024 * 1024);
    const grande = pdf('Conjunto no limite ficticio', 5 * 1024 * 1024);
    const documentos = ['orcamento', 'declaracao_causa_mortis', 'guia_itcmd'].map((tipo, i) => documento(grande, tipo, 'limite-' + i + '.pdf'));
    const recibo = await salvar(pedido({ estado: noLimite, documentos })); const salvo = await detalhe(recibo.id);
    assert.deepEqual(salvo.estado, noLimite); assert.equal(salvo.documentos.length, 3);
    for (const doc of salvo.documentos) await conferirPdf(doc, grande);
  });
  await caso('revogar sessão impede reabrir o PDF já conhecido', async () => {
    const temporario = randomBytes(24).toString('hex'); await db.criarSessao(temporario, usuarios.a);
    const doc = (await versao(1)).documentos[0]; await conferirPdf(doc, PDF_V1, temporario);
    await db.encerrarSessao(temporario); assert.equal((await requisitar('/documentos/' + doc.id, temporario)).status, 401);
  });
});
