// horas-uteis.js — calendário da serventia: expediente, feriados e horas úteis.
//
// Toda métrica dos relatórios das escreventes é contada em HORAS ÚTEIS: só o tempo
// dentro do expediente, de segunda a sexta, fora dos feriados. Um cartão que entra
// sexta às 16h e sai segunda às 9h ficou 2 horas úteis na lista, não 65 corridas.
//
// Fuso: Sergipe segue America/Maceio, UTC-3 fixo (o Brasil não tem horário de verão
// desde 2019). Por isso a conta usa deslocamento fixo, sem biblioteca de fuso.
//
// Variáveis (Railway), todas opcionais:
//   EXPEDIENTE      — faixas do dia, "08:00-12:00,13:00-17:00" (padrão: 8 h úteis por dia)
//   FERIADOS_EXTRA  — datas a mais, separadas por vírgula: "MM-DD" vale todo ano
//                     (feriado municipal) e "AAAA-MM-DD" vale só naquele dia
//                     (ponto facultativo, recesso). Ex.: "08-28,12-08,2026-12-24"
'use strict';

const OFFSET_MS = -3 * 3600e3;   // America/Maceio
const DIA_MS = 86400e3;

// Nacionais fixos (Lei 662/1949, Lei 6.802/1980, Lei 14.759/2023) + Sergipe (8/7,
// emancipação política, Constituição Estadual). Os móveis saem da Páscoa.
const FIXOS = ['01-01', '04-21', '05-01', '07-08', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'];

function p2(n) { return String(n).padStart(2, '0'); }

// Páscoa pelo algoritmo de Meeus/Jones/Butcher (calendário gregoriano)
function pascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(ano, mes - 1, dia);
}

function chave(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

function lerExpediente(texto) {
  const faixas = String(texto || '').split(',').map(s => s.trim()).filter(Boolean).map(f => {
    const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(f);
    if (!m) throw new Error(`EXPEDIENTE inválido: "${f}" (use HH:MM-HH:MM)`);
    const ini = (+m[1]) * 60 + (+m[2]), fim = (+m[3]) * 60 + (+m[4]);
    if (!(fim > ini && fim <= 24 * 60)) throw new Error(`EXPEDIENTE inválido: "${f}"`);
    return [ini, fim];
  }).sort((a, b) => a[0] - b[0]);
  if (!faixas.length) throw new Error('EXPEDIENTE vazio');
  return faixas;
}

function criarCalendario({ expediente = '08:00-12:00,13:00-17:00', feriadosExtra = '' } = {}) {
  const faixas = lerExpediente(expediente);
  const extras = String(feriadosExtra || '').split(',').map(s => s.trim()).filter(Boolean);
  const anuais = extras.filter(s => /^\d{2}-\d{2}$/.test(s));
  const avulsos = new Set(extras.filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s)));
  const porAno = new Map();

  function feriadosDoAno(ano) {
    if (!porAno.has(ano)) {
      const s = new Set([...FIXOS, ...anuais].map(md => `${ano}-${md}`));
      const pa = pascoa(ano);
      for (const delta of [-48, -47, -2, 60]) s.add(chave(pa + delta * DIA_MS)); // carnaval (2ª e 3ª), Sexta-feira Santa, Corpus Christi
      for (const a of avulsos) if (a.startsWith(ano + '-')) s.add(a);
      porAno.set(ano, s);
    }
    return porAno.get(ano);
  }

  // "AAAA-MM-DD" local → é dia de expediente?
  function ehDiaUtil(dataISO) {
    const ms = Date.UTC(+dataISO.slice(0, 4), +dataISO.slice(5, 7) - 1, +dataISO.slice(8, 10));
    const sem = new Date(ms).getUTCDay();
    if (sem === 0 || sem === 6) return false;
    return !feriadosDoAno(+dataISO.slice(0, 4)).has(dataISO);
  }

  // Horas úteis entre dois instantes (Date, ISO ou ms). Nulo/invertido → 0.
  function horasUteis(inicio, fim) {
    if (inicio == null || fim == null) return 0;
    const t0 = new Date(inicio).getTime(), t1 = new Date(fim).getTime();
    if (!(t1 > t0)) return 0;
    let total = 0;
    // meia-noite local do primeiro dia, expressa em ms UTC
    let dia = Math.floor((t0 + OFFSET_MS) / DIA_MS) * DIA_MS - OFFSET_MS;
    for (; dia <= t1; dia += DIA_MS) {
      if (!ehDiaUtil(chave(dia + OFFSET_MS))) continue;
      for (const [a, b] of faixas) {
        const ini = Math.max(t0, dia + a * 60000), fimF = Math.min(t1, dia + b * 60000);
        if (fimF > ini) total += fimF - ini;
      }
    }
    return total / 3600e3;
  }

  const horasPorDia = faixas.reduce((s, [a, b]) => s + (b - a), 0) / 60;
  return { horasUteis, ehDiaUtil, feriadosDoAno, horasPorDia, faixas };
}

// ---- datas locais (America/Maceio) para o agendador e os períodos dos relatórios ----
// Partes da data/hora local de um instante.
function local(instante = new Date()) {
  const d = new Date(new Date(instante).getTime() + OFFSET_MS);
  return {
    ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate(),
    diaSemana: d.getUTCDay(), minutos: d.getUTCHours() * 60 + d.getUTCMinutes(),
    data: chave(d.getTime())
  };
}
// Instante (Date) da meia-noite local de "AAAA-MM-DD".
function meiaNoiteLocal(dataISO) {
  return new Date(Date.UTC(+dataISO.slice(0, 4), +dataISO.slice(5, 7) - 1, +dataISO.slice(8, 10)) - OFFSET_MS);
}
// "AAAA-MM-DD" somado de n dias.
function somaDias(dataISO, n) {
  return chave(Date.UTC(+dataISO.slice(0, 4), +dataISO.slice(5, 7) - 1, +dataISO.slice(8, 10)) + n * DIA_MS);
}
function dataBR(dataISO) {
  return `${dataISO.slice(8, 10)}/${dataISO.slice(5, 7)}/${dataISO.slice(0, 4)}`;
}

const padrao = criarCalendario({
  expediente: process.env.EXPEDIENTE || undefined,
  feriadosExtra: process.env.FERIADOS_EXTRA || ''
});

module.exports = {
  criarCalendario, pascoa, local, meiaNoiteLocal, somaDias, dataBR,
  horasUteis: padrao.horasUteis, ehDiaUtil: padrao.ehDiaUtil, calendario: padrao
};
