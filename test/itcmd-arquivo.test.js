'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { validarPedido, validarEstado, validarPDF, MAX_ESTADO, MAX_PDF } = require('../itcmd-arquivo');

// PDF sintético sem dados pessoais; objetos, offsets e xref são reais.
function pdf() {
  const partes = ['%PDF-1.4\n'];
  const offsets = [0];
  for (const [i, corpo] of ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>'].entries()) {
    offsets.push(Buffer.byteLength(partes.join('')));
    partes.push(`${i + 1} 0 obj\n${corpo}\nendobj\n`);
  }
  const inicio = Buffer.byteLength(partes.join(''));
  partes.push('xref\n0 3\n0000000000 65535 f \n' + offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join(''));
  partes.push(`trailer\n<< /Root 1 0 R /Size 3 >>\nstartxref\n${inicio}\n%%EOF\n`);
  return Buffer.from(partes.join(''));
}
const arquivo = () => ({ tipo: 'orcamento', nome: 'Orçamento de teste.pdf', mime: 'application/pdf', base64: pdf().toString('base64') });
const estado = () => ({ modo: 'inventario', hoje: '2026-10-07', inv: [{ nome: 'Pessoa fictícia', bens: [{ valor: 12500.25, fracao: 50 }] }], doa: {}, ufpManual: false, aliquotaManual: null });
const pedido = () => ({ titulo: 'Inventário fictício', protocolo: '0000-TESTE', estado: estado(), versao_base: 0, operacao_id: randomUUID(), documentos: [arquivo()] });
const rejeita = (fn, status = 400) => assert.throws(fn, e => e.status === status);

test('pedido conserva todos os dados e guarda bytes e hash exatos dos PDFs', () => {
  const entrada = pedido(), r = validarPedido(entrada);
  assert.deepEqual(r.estado, entrada.estado);
  assert.deepEqual(r.documentos[0].dados, pdf());
  assert.equal(r.documentos[0].sha256, createHash('sha256').update(pdf()).digest('hex'));
  assert.equal(r.versao_base, 0);
  assert.equal(r.id, null);
});
test('modos inventário, cumulativo e doação podem ser retomados sem restringir campos novos', () => {
  for (const modo of ['inventario', 'cumulativo', 'doacao']) {
    const e = estado(); e.modo = modo; e.campoFuturo = { fracao: 1.5, lista: ['á', null, false] };
    assert.deepEqual(validarEstado(e), e);
  }
  rejeita(() => validarEstado({ modo: 'invalido', inv: [] }));
  rejeita(() => validarEstado({ modo: 'inventario', inv: [] }));
  rejeita(() => validarEstado({ modo: 'doacao', doa: [] }));
});
test('rascunho pode salvar estado ainda sem PDFs', () => {
  const p = pedido(); p.documentos = [];
  assert.deepEqual(validarPedido(p).documentos, []);
});
test('hash de idempotência é estável com a ordem das propriedades e muda com o conteúdo', () => {
  const p = pedido(), v1 = validarPedido(p);
  const e = p.estado;
  p.estado = { aliquotaManual: e.aliquotaManual, ufpManual: e.ufpManual, doa: e.doa, inv: e.inv, hoje: e.hoje, modo: e.modo };
  assert.equal(validarPedido(p).sha256, v1.sha256);
  p.estado.inv[0].bens[0].valor += 1;
  assert.notEqual(validarPedido(p).sha256, v1.sha256);
});
test('identificadores e versão-base não aceitam formas ambíguas', () => {
  for (const operacao_id of ['', 'qualquer', '../arquivo', null]) rejeita(() => validarPedido({ ...pedido(), operacao_id }));
  for (const versao_base of [-1, '0', 0.5, null, 2147483647]) rejeita(() => validarPedido({ ...pedido(), versao_base }));
  rejeita(() => validarPedido({ ...pedido(), versao_base: 1 }));
  assert.equal(validarPedido({ ...pedido(), id: randomUUID(), versao_base: 9 }).versao_base, 9);
});
test('título e protocolo têm limites explícitos e recusam controle de cabeçalhos', () => {
  rejeita(() => validarPedido({ ...pedido(), titulo: ' ' }));
  rejeita(() => validarPedido({ ...pedido(), titulo: 'x'.repeat(161) }));
  rejeita(() => validarPedido({ ...pedido(), protocolo: 'x'.repeat(41) }));
  rejeita(() => validarPedido({ ...pedido(), titulo: 'teste\r\nHeader: x' }));
  assert.equal(validarPedido({ ...pedido(), protocolo: null }).protocolo, '');
});
test('todos os tipos de documento previstos são aceitos', () => {
  for (const tipo of ['orcamento', 'declaracao_causa_mortis', 'declaracao_inter_vivos', 'guia_itcmd']) assert.equal(validarPDF({ ...arquivo(), tipo }).tipo, tipo);
  rejeita(() => validarPDF({ ...arquivo(), tipo: 'outro' }));
});
test('PDF exige MIME, bytes reais, fim e offset estrutural coerentes', () => {
  rejeita(() => validarPDF({ ...arquivo(), mime: 'text/html' }));
  rejeita(() => validarPDF({ ...arquivo(), base64: Buffer.from('<html>teste</html>').toString('base64') }));
  rejeita(() => validarPDF({ ...arquivo(), base64: pdf().subarray(0, -10).toString('base64') }));
  rejeita(() => validarPDF({ ...arquivo(), base64: Buffer.from(pdf().toString().replace(/startxref\n\d+/, 'startxref\n99999999')).toString('base64') }));
  rejeita(() => validarPDF({ ...arquivo(), base64: Buffer.concat([pdf(), Buffer.from('<script>')]).toString('base64') }));
});
test('base64 aceita somente a codificação canônica sem URL nem whitespace', () => {
  for (const base64 of ['', arquivo().base64 + '\n', 'data:application/pdf;base64,' + arquivo().base64, '!!!!', null]) rejeita(() => validarPDF({ ...arquivo(), base64 }));
  rejeita(() => validarPDF({ ...arquivo(), url: 'https://exemplo.invalid/documento.pdf' }));
});
test('nome do download conserva acentos e não admite caminhos ou cabeçalhos', () => {
  const r = validarPDF({ ...arquivo(), nome: '../Orçamento: teste' });
  assert.equal(r.nome, '.._Orçamento_ teste.pdf');
  rejeita(() => validarPDF({ ...arquivo(), nome: 'pdf\r\nHeader: sim' }));
  rejeita(() => validarPDF({ ...arquivo(), nome: '\ud800.pdf' }));
});
test('mais de quatro PDFs e PDFs maiores que 5 MiB são recusados', () => {
  rejeita(() => validarPedido({ ...pedido(), documentos: Array.from({ length: 5 }, arquivo) }));
  rejeita(() => validarPDF({ ...arquivo(), base64: Buffer.alloc(MAX_PDF + 1).toString('base64') }), 413);
});
test('estado tem teto de bytes e de profundidade', () => {
  rejeita(() => validarEstado({ ...estado(), excesso: 'ç'.repeat(MAX_ESTADO / 2) }), 413);
  const s = estado(); let n = s;
  for (let i = 0; i < 25; i++) { n.proximo = {}; n = n.proximo; }
  rejeita(() => validarEstado(s));
});
test('estado recusa prototype pollution em qualquer profundidade e conteúdo não JSON', () => {
  for (const k of ['__proto__', 'constructor', 'prototype']) {
    const s = estado(); s.extra = JSON.parse('{"' + k + '":{"injetado":true}}');
    rejeita(() => validarEstado(s));
  }
  for (const invalido of [Infinity, NaN, undefined, () => {}, new Date()]) rejeita(() => validarEstado({ ...estado(), invalido }));
  const ciclo = estado(); ciclo.ciclo = ciclo; rejeita(() => validarEstado(ciclo));
});
test('estado recusa NUL e Unicode inválido antes de alcançar JSONB', () => {
  rejeita(() => validarEstado({ ...estado(), observacao: 'teste\0fim' }));
  rejeita(() => validarEstado({ ...estado(), observacao: '\ud800' }));
  assert.equal(validarEstado({ ...estado(), observacao: 'Lembrete\nsegunda linha' }).observacao, 'Lembrete\nsegunda linha');
});
