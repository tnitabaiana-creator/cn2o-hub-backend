'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extrairDoTitulo, normalizarTipoAto, TIPOS } = require('../tipos-ato');

// títulos reais dos quadros (e-Protocolo e manuais anteriores a ele)
const REAIS = [
  ['Prot. (CV-Urbano) 1400 - FULANO DE TAL', 1400, 'CV-Urbano'],
  ['Prot. (CV-Urbano) -1063 extra 1521', 1063, 'CV-Urbano'],
  ['Prot. (CDP) -1142 extra 1650', 1142, 'CDP'],
  ['Prot. (CDH)-1311 - Extra 1841', 1311, 'CDH'],
  ['Prot. (Ata Notarial) -1032', 1032, 'ATA'],
  ['Prot. (DOA) -1308; Extra: 1801', 1308, 'DOA'],
  ['Prot. (Ata Transcrição de Áudio) -1224', 1224, 'ATA-W/A'],
  ['Prot. (TESTAMENTO-AMORIM) -1217', 1217, 'TEST'],
  ['Prot. (Ata WhatsApp) -1175 EXTRA 1645', 1175, 'ATA-W/A'],
  ['Prot. (CV-Rural-Dr.Jessica) -1059', 1059, 'CV-Rural'],
  ['Prot. (RERRATIF-MANOEL-ASSINA SEXTA 16H) -0980', 980, 'RERRAT'],
  ['Prot. (ATA NOTARIAL-URGENTE ) -0916 PROT.EXTRA 1343', 916, 'ATA'],
  ['Prot. (CDP) -0946; Extra: 1417', 946, 'CDP'],
  ['Prot. (CERT) 1500 - MARIA', 1500, 'CERT'],
  ['Prot. (CDRU) -1351', 1351, 'CDRU'],
  ['Prot. (CONFIRA🛑) -1268; Extra: 1779', 1268, 'OUTROS']
];

test('títulos reais → protocolo e tipo de ato', () => {
  for (const [titulo, prot, tipo] of REAIS) {
    const r = extrairDoTitulo(titulo);
    assert.equal(r.protocolo, prot, titulo);
    assert.equal(r.tipo_ato, tipo, titulo);
  }
});

test('o ato vem antes do comentário: ganha a regra mais à esquerda', () => {
  assert.equal(normalizarTipoAto('CV - FALTA CERTIDÃO'), 'CV-Urbano');
  assert.equal(normalizarTipoAto('CDP RURAL'), 'CDP');
  assert.equal(normalizarTipoAto('DOA - URGENTE'), 'DOA');
});

test('nomes livres e opções antigas do campo Tipo de Ato', () => {
  const casos = {
    'UE-DIS': 'DUE', 'ATA-USO': 'ATA-U', 'ATA-W': 'ATA-W/A', PERM: 'PER', 'Divórcio': 'DIV',
    'União Estável': 'UE', 'Procuração': 'PROC', 'Inventário': 'INV', 'Dação em pagamento': 'DAC',
    'Direito de Laje': 'LAJE', 'Ata de usucapião': 'ATA-U', 'Permuta': 'PER', 'Doação': 'DOA',
    'Cessão de direitos hereditários': 'CDH', 'Certidão de inteiro teor': 'CERT', XYZ: 'OUTROS', '': 'OUTROS'
  };
  for (const [texto, esperado] of Object.entries(casos)) assert.equal(normalizarTipoAto(texto), esperado, texto);
});

test('os códigos canônicos passam como estão', () => {
  for (const cod of Object.keys(TIPOS)) assert.equal(normalizarTipoAto(cod), cod);
});

test('título sem parênteses e sem número', () => {
  assert.deepEqual(extrairDoTitulo('Prot 1234 escritura'), { protocolo: 1234, tipo_ato: 'OUTROS', rotulo: '1234 escritura' });
  assert.equal(extrairDoTitulo('Cartão qualquer').protocolo, null);
  assert.equal(extrairDoTitulo(null).tipo_ato, 'OUTROS');
});
