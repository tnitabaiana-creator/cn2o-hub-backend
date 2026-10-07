'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { validarImagem, MAX_BYTES } = require('../agenda-imagem');

// Imagens sintéticas 3 x 2, geradas com Pillow; sem documentos ou dados pessoais.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFElEQVR4nGP8//8/AxgwQSgGBgYANgYDARtTfJEAAAAASUVORK5CYII=';
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';
const WEBP = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoDAAIAAUAmJaQAA3AA/vz0AAA=';
const samples = [['image/png', PNG], ['image/jpeg', JPEG], ['image/webp', WEBP]];
const invalida = (mime, base64, status = 400) => assert.throws(() => validarImagem({ mime, base64 }), e => e.status === status);

for (const [mime, base64] of samples) {
  test('aceita imagem real pequena e calcula metadados: ' + mime, () => {
    const r = validarImagem({ mime, base64 });
    assert.equal(r.largura, 3); assert.equal(r.altura, 2); assert.equal(r.mime, mime);
    assert.equal(r.hash, createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex'));
    assert.deepEqual(r.dados, Buffer.from(base64, 'base64'));
  });
  test('recusa arquivo truncado: ' + mime, () => {
    const b = Buffer.from(base64, 'base64');
    invalida(mime, b.subarray(0, b.length - 3).toString('base64'));
  });
  test('recusa dados anexados após o fim da imagem: ' + mime, () => {
    invalida(mime, Buffer.concat([Buffer.from(base64, 'base64'), Buffer.from('<script>')]).toString('base64'));
  });
}
test('recusa MIME que não corresponde aos bytes e formatos ativos', () => {
  invalida('image/jpeg', PNG); invalida('image/png', WEBP); invalida('image/webp', JPEG);
  invalida('image/svg+xml', Buffer.from('<svg/>').toString('base64'));
  invalida('image/gif', 'R0lGODlh'); invalida('text/html', PNG);
});
test('recusa base64 incompleto, com whitespace, data URL ou tipo incorreto', () => {
  for (const b of ['', PNG.slice(0, -1), PNG + '\n', 'data:image/png;base64,' + PNG, '!!!!', null, ['x']]) invalida('image/png', b);
  assert.throws(() => validarImagem(null), e => e.status === 400);
  assert.throws(() => validarImagem([]), e => e.status === 400);
});
test('rejeita bytes de padding não canônicos mesmo quando decodificáveis', () => {
  assert.ok(PNG.endsWith('II='));
  const adulterada = PNG.slice(0, -2) + 'J=';
  assert.deepEqual(Buffer.from(adulterada, 'base64'), Buffer.from(PNG, 'base64'));
  invalida('image/png', adulterada);
});
test('limite de 1 MiB considera bytes decodificados e retorna 413', () => {
  invalida('image/png', Buffer.alloc(MAX_BYTES + 1).toString('base64'), 413);
  invalida('image/png', 'A'.repeat(4 * Math.ceil((MAX_BYTES + 4) / 3)), 413);
});
test('payload próximo do limite não estoura pilha da validação de base64', () => {
  invalida('image/png', Buffer.alloc(MAX_BYTES).toString('base64'));
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
test('PNG: CRC detecta corrupção; dimensões e quantidade de pixels são limitadas', () => {
  const corrompida = Buffer.from(PNG, 'base64'); corrompida[18] ^= 1;
  invalida('image/png', corrompida.toString('base64'));
  for (const [w, h] of [[0, 1], [4097, 1], [1, 4097], [4000, 3000]]) {
    const b = Buffer.from(PNG, 'base64'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b.writeUInt32BE(crc32(b.subarray(12, 29)), 29);
    assert.throws(() => validarImagem({ mime: 'image/png', base64: b.toString('base64') }), /dimensões/);
  }
});
test('WebP: rejeita RIFF com comprimento incorreto e dimensão abusiva', () => {
  const b = Buffer.from(WEBP, 'base64'); b.writeUInt32LE(b.length, 4); invalida('image/webp', b.toString('base64'));
  const enorme = Buffer.from(WEBP, 'base64'); enorme.writeUInt16LE(4097, 26);
  assert.throws(() => validarImagem({ mime: 'image/webp', base64: enorme.toString('base64') }), /dimensões/);
});
test('WebP: animação não cabe na funcionalidade de print estático', () => {
  const anim = Buffer.from(WEBP, 'base64'); anim.write('ANIM', 12, 'ascii');
  assert.throws(() => validarImagem({ mime: 'image/webp', base64: anim.toString('base64') }), /estática/);
});
