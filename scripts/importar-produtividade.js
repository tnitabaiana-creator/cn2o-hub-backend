'use strict';
// Executar somente com DATABASE_URL do destino autorizado. Nunca registra HTML,
// nomes de clientes, estados financeiros, URI do banco nem mensagens SQL.
const fs = require('node:fs/promises');
const { Pool } = require('pg');
const storage = require('../gestao-relatorios-db');
async function lerBase64(entrada) {
  const partes = []; let bytes = 0;
  const limite = Math.ceil(storage.MAX_BYTES / 3) * 4;
  for await (const parte of entrada) {
    const p = Buffer.isBuffer(parte) ? parte : Buffer.from(parte);
    bytes += p.length;
    if (bytes > limite) throw storage.erro(413, 'ARQUIVO_GRANDE', 'o HTML deve ter até 2 MiB');
    partes.push(p);
  }
  const base64 = Buffer.concat(partes).toString('utf8');
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) throw storage.erro(400, 'HTML_INVALIDO', 'entrada base64 inválida');
  const dados = Buffer.from(base64, 'base64');
  if (dados.toString('base64') !== base64) throw storage.erro(400, 'HTML_INVALIDO', 'entrada base64 inválida');
  return dados;
}
async function main(args = process.argv.slice(2)) {
  const permitidos = new Set(['--arquivo', '--stdin-base64', '--autor', '--substituir']);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!permitidos.has(a) || Object.hasOwn(opts, a)) throw storage.erro(400, 'ARGUMENTOS_INVALIDOS', 'uso: node scripts/importar-produtividade.js (--arquivo CAMINHO | --stdin-base64) --autor LOGIN [--substituir]');
    if (a === '--substituir' || a === '--stdin-base64') opts[a] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw storage.erro(400, 'ARGUMENTOS_INVALIDOS', 'informe arquivo e responsável');
      opts[a] = args[++i];
    }
  }
  if ((!opts['--arquivo'] && !opts['--stdin-base64']) || (opts['--arquivo'] && opts['--stdin-base64']) || !opts['--autor']) throw storage.erro(400, 'ARGUMENTOS_INVALIDOS', 'informe uma fonte (--arquivo ou --stdin-base64) e --autor');
  if (!process.env.DATABASE_URL) throw storage.erro(400, 'BANCO_NAO_CONFIGURADO', 'DATABASE_URL não configurada');
  let dados;
  if (opts['--stdin-base64']) dados = await lerBase64(process.stdin);
  else {
    const stat = await fs.stat(opts['--arquivo']);
    if (!stat.isFile() || stat.size > storage.MAX_BYTES) throw storage.erro(413, 'ARQUIVO_GRANDE', 'informe um arquivo HTML de até 2 MiB');
    dados = await fs.readFile(opts['--arquivo']);
  }
  storage.validarHTML(dados);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 15000 });
  try {
    const resultado = await storage.importar(pool, { dados, autor: opts['--autor'], substituir: opts['--substituir'] === true });
    console.log(JSON.stringify({ chave: storage.CHAVE, ...resultado }));
    return resultado;
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(e => {
  console.error([400, 409, 413].includes(e.status) ? e.message : 'não foi possível importar o relatório; nenhum salvamento foi confirmado');
  process.exitCode = 1;
});
module.exports = { main, lerBase64 };
