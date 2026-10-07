'use strict';

const { createHash } = require('node:crypto');
const MAX_BYTES = 1024 * 1024;
const MAX_LADO = 4096;
const MAX_PIXELS = 10000000;

function invalida(mensagem, status = 400) {
  const erro = new Error(mensagem);
  erro.status = status;
  return erro;
}
function tamanho(largura, altura) {
  if (!largura || !altura || largura > MAX_LADO || altura > MAX_LADO || largura * altura > MAX_PIXELS) {
    throw invalida('imagem grande demais em dimensões — use até 4096 pixels por lado e 10 megapixels');
  }
  return { largura, altura };
}
function estrutura() { throw invalida('imagem inválida ou incompleta — use um print PNG, JPEG ou WebP'); }

const CRC = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let n = 0xffffffff;
  for (const b of bytes) n = CRC[(n ^ b) & 255] ^ (n >>> 8);
  return (n ^ 0xffffffff) >>> 0;
}
function png(b) {
  if (b.length < 45 || !b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) estrutura();
  let pos = 8, dimensoes, dados = false, fim = false;
  while (pos + 12 <= b.length) {
    const len = b.readUInt32BE(pos), tipo = b.toString('ascii', pos + 4, pos + 8), final = pos + 12 + len;
    if (final > b.length || !/^[A-Za-z]{4}$/.test(tipo) || crc32(b.subarray(pos + 4, final - 4)) !== b.readUInt32BE(final - 4)) estrutura();
    if (!dimensoes && tipo !== 'IHDR') estrutura();
    if (tipo === 'IHDR') {
      if (dimensoes || len !== 13) estrutura();
      dimensoes = tamanho(b.readUInt32BE(pos + 8), b.readUInt32BE(pos + 12));
      const profundidade = b[pos + 16], cor = b[pos + 17];
      const bits = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!bits[cor]?.includes(profundidade) || b[pos + 18] !== 0 || b[pos + 19] !== 0 || b[pos + 20] > 1) estrutura();
    } else if (tipo === 'acTL') {
      throw invalida('use uma imagem estática, sem animação');
    } else if (tipo === 'IDAT') {
      if (len) dados = true;
    } else if (tipo === 'IEND') {
      if (len !== 0 || final !== b.length || !dados) estrutura();
      fim = true;
    }
    pos = final;
  }
  if (!fim || pos !== b.length) estrutura();
  return dimensoes;
}
function jpeg(b) {
  if (b.length < 20 || b[0] !== 255 || b[1] !== 216) estrutura();
  let pos = 2, dimensoes, scan = false;
  while (pos < b.length) {
    if (b[pos++] !== 255) estrutura();
    while (b[pos] === 255) pos++;
    const marcador = b[pos++];
    if (marcador === 217) {
      if (!dimensoes || !scan || pos !== b.length) estrutura();
      return dimensoes;
    }
    if (marcador === 0 || marcador === 216 || (marcador >= 208 && marcador <= 215) || pos + 2 > b.length) estrutura();
    const len = b.readUInt16BE(pos);
    if (len < 2 || pos + len > b.length) estrutura();
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marcador)) {
      if (len < 8 || dimensoes) estrutura();
      dimensoes = tamanho(b.readUInt16BE(pos + 5), b.readUInt16BE(pos + 3));
      if (!b[pos + 7] || len !== 8 + 3 * b[pos + 7]) estrutura();
    }
    pos += len;
    if (marcador === 218) {
      if (!dimensoes || len < 6) estrutura();
      scan = true;
      // Dados comprimidos: FF00 é byte escapado; FFD0..D7 são marcadores de reinício.
      while (pos < b.length) {
        if (b[pos] !== 255) { pos++; continue; }
        let seguinte = pos + 1;
        while (b[seguinte] === 255) seguinte++;
        if (b[seguinte] === 0 || (b[seguinte] >= 208 && b[seguinte] <= 215)) { pos = seguinte + 1; continue; }
        break;
      }
    }
  }
  estrutura();
}
function webp(b) {
  if (b.length < 26 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP' || b.readUInt32LE(4) + 8 !== b.length) estrutura();
  let pos = 12, dimensoes, canvas;
  while (pos + 8 <= b.length) {
    const tipo = b.toString('ascii', pos, pos + 4), len = b.readUInt32LE(pos + 4), ini = pos + 8;
    const final = ini + len + (len % 2);
    if (final > b.length) estrutura();
    if (tipo === 'ANIM' || tipo === 'ANMF') throw invalida('use uma imagem estática, sem animação');
    if (tipo === 'VP8X') {
      if (pos !== 12 || len !== 10 || canvas || (b[ini] & 2)) estrutura();
      canvas = tamanho(b.readUIntLE(ini + 4, 3) + 1, b.readUIntLE(ini + 7, 3) + 1);
    } else if (tipo === 'VP8 ') {
      if (dimensoes || len < 10 || (b[ini] & 1) || !b.subarray(ini + 3, ini + 6).equals(Buffer.from([157, 1, 42]))) estrutura();
      dimensoes = tamanho(b.readUInt16LE(ini + 6) & 0x3fff, b.readUInt16LE(ini + 8) & 0x3fff);
    } else if (tipo === 'VP8L') {
      if (dimensoes || len < 5 || b[ini] !== 47 || b[ini + 4] >>> 5) estrutura();
      const bits = b.readUInt32LE(ini + 1);
      dimensoes = tamanho((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    pos = final;
  }
  if (pos !== b.length || !dimensoes || (canvas && (canvas.largura !== dimensoes.largura || canvas.altura !== dimensoes.altura))) estrutura();
  return dimensoes;
}
function validarImagem(imagem) {
  if (!imagem || typeof imagem !== 'object' || Array.isArray(imagem)) throw invalida('informe a imagem ou null para remover');
  const { mime, base64 } = imagem;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw invalida('use uma imagem PNG, JPEG ou WebP');
  if (typeof base64 !== 'string' || !base64.length || base64.length % 4 !== 0) estrutura();
  if (base64.length > Math.ceil(MAX_BYTES / 3) * 4) throw invalida('imagem grande demais — o limite é 1 MB após a redução', 413);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) estrutura();
  const dados = Buffer.from(base64, 'base64');
  if (dados.length > MAX_BYTES) throw invalida('imagem grande demais — o limite é 1 MB após a redução', 413);
  if (dados.toString('base64') !== base64) estrutura();
  const dimensoes = ({ 'image/png': png, 'image/jpeg': jpeg, 'image/webp': webp })[mime](dados);
  return { dados, mime, hash: createHash('sha256').update(dados).digest('hex'), ...dimensoes };
}

// Nunca seleciona o BYTEA nas listagens: só metadados leves para montar a agenda.
const SQL_METADATA = `CASE WHEN imagem_dados IS NULL THEN NULL ELSE json_build_object(
  'mime', imagem_mime, 'bytes', octet_length(imagem_dados), 'versao', imagem_hash) END AS imagem`;

async function salvarCelula(pool, login, dia, faixa, alteracao) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    // O lock também cobre a célula ainda inexistente. Texto e imagem usam o mesmo
    // lock, portanto uma remoção não apaga um upload concorrente nem vice-versa.
    await cliente.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['hub_agenda', login, dia, faixa])]);
    if (Object.hasOwn(alteracao, 'texto')) {
      await cliente.query(`INSERT INTO hub_agenda (login, dia, faixa, texto) VALUES ($1, $2, $3, $4)
        ON CONFLICT (login, dia, faixa) DO UPDATE SET texto = EXCLUDED.texto, atualizado_em = now()`,
      [login, dia, faixa, alteracao.texto]);
    } else {
      const img = alteracao.imagem;
      await cliente.query(`INSERT INTO hub_agenda (login, dia, faixa, texto, imagem_dados, imagem_mime, imagem_hash)
        VALUES ($1, $2, $3, '', $4, $5, $6) ON CONFLICT (login, dia, faixa) DO UPDATE
        SET imagem_dados = EXCLUDED.imagem_dados, imagem_mime = EXCLUDED.imagem_mime,
            imagem_hash = EXCLUDED.imagem_hash, atualizado_em = now()`,
      [login, dia, faixa, img?.dados || null, img?.mime || null, img?.hash || null]);
    }
    await cliente.query(`DELETE FROM hub_agenda WHERE login = $1 AND dia = $2 AND faixa = $3
      AND texto = '' AND imagem_dados IS NULL`, [login, dia, faixa]);
    const resultado = await cliente.query(`SELECT texto, atualizado_em, ${SQL_METADATA}
      FROM hub_agenda WHERE login = $1 AND dia = $2 AND faixa = $3`, [login, dia, faixa]);
    await cliente.query('COMMIT');
    return resultado.rows[0] || { texto: '', imagem: null, apagado: true };
  } catch (erro) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw erro;
  } finally { cliente.release(); }
}

module.exports = { MAX_BYTES, MAX_LADO, MAX_PIXELS, SQL_METADATA, validarImagem, salvarCelula };
