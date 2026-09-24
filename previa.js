// previa.js — gera o relatório em arquivo (HTML + CSV), sem enviar nada.
//
//   npm run previa -- --tipo semanal --ref 2026-09-28 [--saida pasta]
//
// "ref" é o dia em que o relatório seria enviado: semanal → a semana anterior a ele;
// mensal → o mês anterior. Precisa de DATABASE_URL; com TRELLO_KEY/TOKEN inclui também
// os cartões que estão agora nos quadros.
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { gerar } = require('./relatorios');
const { local } = require('./horas-uteis');

(async () => {
  const args = process.argv.slice(2);
  const valor = (nome, padrao) => { const i = args.indexOf(nome); return i >= 0 ? args[i + 1] : padrao; };
  const tipo = valor('--tipo', 'semanal');
  const ref = valor('--ref', local().data);
  const saida = path.resolve(valor('--saida', 'relatorios-saida'));
  if (!['semanal', 'mensal'].includes(tipo)) throw new Error('--tipo deve ser semanal ou mensal');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ref)) throw new Error('--ref deve ser AAAA-MM-DD');
  await require('./db-relatorios').init();
  const g = await gerar(tipo, ref, { wip: !!(process.env.TRELLO_KEY && process.env.TRELLO_TOKEN) });
  fs.mkdirSync(saida, { recursive: true });
  const base = path.join(saida, `relatorio-${tipo}-${g.rel.periodo.inicioISO}_${g.rel.periodo.fimISO}`);
  fs.writeFileSync(base + '.html', g.html);
  fs.writeFileSync(base + '.csv', g.csv);
  console.log(`${g.assunto}\n  ${base}.html\n  ${base}.csv\n  ${g.rel.equipe.concluidos} ato(s) concluído(s) no período`);
})()
  .then(() => db.pool.end())
  .catch(e => { console.error(e.message); db.pool.end().finally(() => process.exit(1)); });
