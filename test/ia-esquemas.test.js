'use strict';
// v1.49 — esquemas JSON da transposição e do dossiê ITCMD (hub.js): toda chave que o
// normalizador lê está no esquema, e o esquema segue as regras da API (objetos fechados,
// todas as chaves obrigatórias).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const fonte = fs.readFileSync(path.join(__dirname, '..', 'hub.js'), 'utf8');
const ini = fonte.indexOf('const CHAVES_PESSOA');
const fim = fonte.indexOf('// ---------------------------------------------------------------- Minuta → Google Docs (v1.29)');
const ctx = vm.createContext({});
vm.runInContext(fonte.slice(ini, fim) +
  '\nthis.x = { ESQUEMA_TRANSPOR, ESQUEMA_ITCMD, normalizarTransposicao, normalizarDossieItcmd };', ctx);
const X = ctx.x;

// Instância "cheia" a partir do esquema: texto "x1", enum o 1º valor, booleano true, inteiro 1,
// lista com um item, anyOf a 1ª opção (o objeto, não o null).
function cheio(s, chave) {
  if (s.anyOf) return cheio(s.anyOf[0], chave);
  if (s.enum) return s.enum[0];
  switch (s.type) {
    case 'object': return Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, cheio(v, k)]));
    case 'array': return [cheio(s.items, chave)];
    case 'boolean': return true;
    case 'integer': return 1;
    default: return /valor|fracao|dividas|doacoes_anteriores|itcmd_recolhido/.test(chave || '') ? '50' : 'x1';
  }
}
function regrasDaApi(s, onde = '$') {
  if (s.anyOf) return s.anyOf.forEach((o, i) => regrasDaApi(o, onde + '|' + i));
  if (s.type === 'object') {
    assert.equal(s.additionalProperties, false, onde);
    assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), onde);
    Object.entries(s.properties).forEach(([k, v]) => regrasDaApi(v, onde + '.' + k));
  }
  if (s.type === 'array') regrasDaApi(s.items, onde + '[]');
}
// Folhas vazias na saída normalizada = chave que o normalizador lê e o esquema não tem.
function folhasVazias(o, onde = '$', fora = []) {
  if (Array.isArray(o)) { if (!o.length) fora.push(onde + ' (lista vazia)'); o.forEach((v, i) => folhasVazias(v, onde + '[' + i + ']', fora)); }
  else if (o && typeof o === 'object') Object.entries(o).forEach(([k, v]) => folhasVazias(v, onde + '.' + k, fora));
  else if (o === '' || o === null) fora.push(onde);
  return fora;
}

test('esquemas seguem as regras da API (objetos fechados, todas as chaves obrigatórias)', () => {
  regrasDaApi(X.ESQUEMA_TRANSPOR);
  regrasDaApi(X.ESQUEMA_ITCMD);
});

test('transposição: o normalizador aproveita tudo o que o esquema pede (inclusive nome_solteiro em pares)', () => {
  const bruto = cheio(X.ESQUEMA_TRANSPOR);
  const n = X.normalizarTransposicao(bruto);
  assert.deepEqual(folhasVazias(n), []);
  assert.equal(JSON.stringify(n.casamento.nome_solteiro), '{"x1":"x1"}');   // vm: objeto de outro contexto
});

test('ITCMD: o normalizador aproveita tudo o que o esquema pede', () => {
  const bruto = cheio(X.ESQUEMA_ITCMD);
  bruto.operacao = 'inventario';
  const n = X.normalizarDossieItcmd(bruto);
  assert.deepEqual(folhasVazias(n), []);
});
