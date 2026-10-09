'use strict';
// CLI operacional privada. Não recebe URL do banco em argumento, não publica
// registros e não aplica dados sem --aplicar explícito.
const fs = require('node:fs/promises');
const { Pool } = require('pg');
const store = require('../atos-lavrados-db');
function argumentos(args) {
  const permitidos = new Set(['--arquivo', '--stdin-base64', '--autor', '--aplicar']);
  const op = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (!permitidos.has(k) || Object.hasOwn(op, k)) throw store.erro(400, 'ARGUMENTOS_INVALIDOS', 'uso: node scripts/importar-atos-lavrados.js (--arquivo CAMINHO | --stdin-base64) --autor LOGIN [--aplicar]');
    if (k === '--stdin-base64' || k === '--aplicar') op[k] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw store.erro(400, 'ARGUMENTOS_INVALIDOS', 'informe a fonte e o responsável');
      op[k] = args[++i];
    }
  }
  if ((!op['--arquivo'] && !op['--stdin-base64']) || (op['--arquivo'] && op['--stdin-base64']) || !op['--autor']) throw store.erro(400, 'ARGUMENTOS_INVALIDOS', 'informe uma fonte e --autor');
  return op;
}
async function lerBase64(stream) {
  const partes = []; let n = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); n += b.length;
    if (n > Math.ceil(store.MAX_BYTES / 3) * 4) throw store.erro(413, 'LOTE_GRANDE', 'lote maior que 20 MiB');
    partes.push(b);
  }
  const b64 = Buffer.concat(partes).toString('utf8');
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) throw store.erro(400, 'BASE64_INVALIDO', 'base64 inválido; envie o JSON UTF-8 codificado, sem quebra de linha');
  const b = Buffer.from(b64, 'base64');
  if (b.toString('base64') !== b64 || b.length > store.MAX_BYTES) throw store.erro(400, 'BASE64_INVALIDO', 'base64 inválido');
  return b;
}
async function main(args = process.argv.slice(2), entrada = process.stdin) {
  const op = argumentos(args);
  if (!process.env.DATABASE_URL) throw store.erro(400, 'BANCO_NAO_CONFIGURADO', 'DATABASE_URL não configurada');
  let bytes;
  if (op['--stdin-base64']) bytes = await lerBase64(entrada);
  else {
    const stat = await fs.stat(op['--arquivo']);
    if (!stat.isFile() || stat.size > store.MAX_BYTES) throw store.erro(413, 'LOTE_GRANDE', 'informe um arquivo JSON de até 20 MiB');
    bytes = await fs.readFile(op['--arquivo']);
  }
  if (!Buffer.from(bytes.toString('utf8')).equals(bytes)) throw store.erro(400, 'JSON_INVALIDO', 'use um lote JSON em UTF-8');
  let lote;
  try { lote = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw store.erro(400, 'JSON_INVALIDO', 'JSON inválido'); }
  store.validarLote(lote);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 15000 });
  try {
    const resultado = await store.importar(pool, lote, op['--autor'], op['--aplicar'] !== true);
    // Apenas recibo técnico; originais e conteúdo completo permanecem no banco.
    console.log(JSON.stringify({ modo: op['--aplicar'] ? 'aplicacao' : 'previa', ...resultado }));
    return resultado;
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(e => {
  console.error([400, 409, 413].includes(e.status) ? e.message : 'não foi possível concluir a importação; consulte o recibo e as versões antes de repetir');
  process.exitCode = 1;
});
module.exports = { argumentos, lerBase64, main };
