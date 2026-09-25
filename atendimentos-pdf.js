// atendimentos-pdf.js — PDF mensal de atendimentos (2 folhas A4, identidade CN2O), v1.39.
//
// Transposto do workflow "CN2O · NextQS → Relatório mensal (PDF)" do n8n, sem dependências:
// escreve o PDF à mão com Helvetica/Helvetica-Bold (fontes padrão do leitor, WinAnsi).
// Folha 1: seis números do mês (com a variação sobre o mês anterior), atendidas por dia,
// dia da semana e horário de pico. Folha 2: filas e serviços, equipe e notas.
// Entrada: as linhas de atendimentos_dia do mês e do mês anterior ({ dia, dados }).
'use strict';

// larguras (1/1000 em) dos caracteres 32–255 de Helvetica e Helvetica-Bold, WinAnsi
const LR = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,556,556,556,222,556,333,1000,556,556,333,1000,667,333,1000,556,611,556,556,222,222,333,333,350,556,1000,333,1000,500,333,944,556,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,556,737,333,400,584,556,556,333,556,537,278,333,556,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500];
const LB = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,611,556,611,278,556,500,1000,556,556,333,1000,667,333,1000,611,611,611,611,278,278,500,500,350,556,1000,333,1000,556,333,944,611,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,611,737,333,400,584,611,611,333,611,556,278,333,611,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556];

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const DSEM = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const nomeMes = ym => MESES[+ym.slice(5, 7) - 1] + ' de ' + ym.slice(0, 4);
const W = 595.28, H = 841.89, X0 = 40, X1 = W - 40, LW = X1 - X0;
const COR = {
  v: [.388, .075, .145], m: [.125, .165, .227], m2: [.227, .267, .329], br: [1, 1, 1],
  mp: [.894, .918, .957], sa: [.929, .953, .925], ro: [.953, .902, .914], pa: [.984, .961, .867],
  grade: [.86, .87, .89], zebra: [.965, .969, .976], m18: [.8, .82, .85]
};
const CP = { '€': 128, '‚': 130, 'ƒ': 131, '„': 132, '…': 133, '†': 134, '‡': 135, 'ˆ': 136, '‰': 137, 'Š': 138, '‹': 139, 'Œ': 140, 'Ž': 142, '‘': 145, '’': 146, '“': 147, '”': 148, '•': 149, '–': 150, '—': 151, '˜': 152, '™': 153, 'š': 154, '›': 155, 'œ': 156, 'ž': 158, 'Ÿ': 159 };

// ---------------------------------------------------------------- números
const vazio = () => ({ em: 0, at: 0, na: 0, te: 0, tw: 0, ta: 0, aw: 0, cs: 0, cn: 0 });
function soma(a, r) {
  a.em += r[4] || 0; a.at += r[5] || 0; a.na += r[6] || 0; a.te += r[7] || 0; a.tw += r[8] || 0;
  a.ta += r[9] || 0; a.aw += r[10] || 0; a.cs += r[11] || 0; a.cn += r[12] || 0;
}
const limpa = v => String(v == null ? '' : v).split('\t').join(' ').replace(/ +/g, ' ').trim();
const media = (s, w) => (w ? s / w : null);
const variacao = (a, b) => (a == null || b == null || !b ? null : (a - b) / b);
function fmtN(n) {
  if (n == null || isNaN(n)) return '—';
  let t = String(Math.abs(Math.round(n))), o = '';
  while (t.length > 3) { o = '.' + t.slice(-3) + o; t = t.slice(0, -3); }
  return (n < 0 ? '-' : '') + t + o;
}
const fmtP = n => (n == null || isNaN(n) ? '—' : (Math.round(n * 1e3) / 10).toString().replace('.', ',') + '%');
function fmtT(s) {
  if (s == null || isNaN(s)) return '—';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return h ? h + 'h' + String(m).padStart(2, '0') : m + 'min ' + String(x).padStart(2, '0') + 's';
}

function agregar(linhas, mes) {
  const tot = vazio(), dias = {}, filas = {}, ats = {}, horas = {};
  const dsem = [0, 1, 2, 3, 4, 5, 6].map(() => ({ s: 0, n: 0 }));
  for (const x of linhas) {
    if (String(x.dia).slice(0, 7) !== mes) continue;
    let d;
    try { d = typeof x.dados === 'string' ? JSON.parse(x.dados) : x.dados; } catch (e) { continue; }
    if (!d) continue;
    const td = vazio();
    for (const r of d.r || []) {
      soma(tot, r); soma(td, r);
      const f = limpa(r[0]) || '(sem fila)';
      soma(filas[f] || (filas[f] = vazio()), r);
      const a = limpa(r[1]);
      if (a) soma(ats[a] || (ats[a] = vazio()), r);
    }
    dias[x.dia] = td;
    for (const [h, n] of d.h || []) horas[h] = (horas[h] || 0) + n;
    if (td.em > 0) { const w = new Date(x.dia + 'T12:00:00Z').getUTCDay(); dsem[w].s += td.at; dsem[w].n++; }
  }
  return { tot, dias, filas, ats, horas, dsem, nd: Object.values(dias).filter(t => t.em > 0).length };
}

// ---------------------------------------------------------------- texto em PDF
function cp(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128 || (c >= 160 && c < 256)) return c;
  if (CP[ch]) return CP[ch];
  if (ch === '−') return 45;
  return 63;
}
function larg(t, tam, neg) {
  let w = 0;
  for (const ch of String(t)) { const c = cp(ch); w += c >= 32 ? (neg ? LB : LR)[c - 32] : 556; }
  return w * tam / 1e3;
}
function pdfStr(t) {
  let o = '';
  for (const ch of String(t)) {
    const c = cp(ch);
    if (c === 40 || c === 41 || c === 92) o += '\\' + String.fromCharCode(c);
    else if (c < 32 || c > 126) o += '\\' + c.toString(8).padStart(3, '0');
    else o += String.fromCharCode(c);
  }
  return o;
}
const rgb = c => c.map(v => v.toFixed(3)).join(' ');

class Pagina {
  constructor() { this.o = []; }
  ret(x, y, w, h, cor) { this.o.push(`${rgb(cor)} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`); }
  linha(x1, y1, x2, y2, cor, esp, trac) {
    this.o.push(`${trac ? '[3 3] 0 d ' : '[] 0 d '}${rgb(cor)} RG ${esp || 0.6} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }
  txt(x, y, t, tam, neg, cor, alinh) {
    t = String(t);
    const w = larg(t, tam, neg);
    if (alinh === 'd') x -= w; else if (alinh === 'c') x -= w / 2;
    this.o.push(`BT /${neg ? 'F2' : 'F1'} ${tam} Tf ${rgb(cor || COR.m)} rg ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfStr(t)}) Tj ET`);
    return w;
  }
  caber(t, tam, neg, max) {
    t = String(t);
    if (larg(t, tam, neg) <= max) return t;
    while (t.length > 1 && larg(t + '…', tam, neg) > max) t = t.slice(0, -1);
    return t + '…';
  }
  serra(x, y, esc, cor) {
    const P = [[0, 160, 60, 120, 90, 150, 150, 110, 210, 70, 250, 80, 300, 40], [0, 180, 70, 140, 100, 168, 160, 128, 220, 88, 260, 100, 300, 62], [0, 140, 50, 104, 84, 132, 144, 94, 204, 56, 244, 62, 300, 20]];
    const t = (a, b) => `${(x + a * esc).toFixed(2)} ${(y - b * esc).toFixed(2)}`;
    P.forEach(p => this.o.push(`[] 0 d ${rgb(cor)} RG .8 w ${t(p[0], p[1])} m ${t(p[2], p[3])} ${t(p[4], p[5])} ${t(p[6], p[7])} c ${t(p[8], p[9])} ${t(p[10], p[11])} ${t(p[12], p[13])} c S`));
  }
}

// ---------------------------------------------------------------- o documento
function montarPdf({ mes, linhas, agora = new Date() }) {
  const y0 = +mes.slice(0, 4), m0 = +mes.slice(5, 7);
  const mesAnterior = new Date(Date.UTC(y0, m0 - 2, 1)).toISOString().slice(0, 7);
  const A = agregar(linhas, mes), P = agregar(linhas, mesAnterior);
  const loc = new Date(agora.getTime() - 3 * 36e5).toISOString();
  const geradoEm = `${loc.slice(8, 10)}/${loc.slice(5, 7)}/${loc.slice(0, 4)} às ${loc.slice(11, 16)}`;
  const pags = [];

  function cabecalho(p, n) {
    p.ret(0, H - 6, W, 6, COR.v);
    p.serra(W - 250, H - 10, 0.75, COR.grade);
    p.txt(X0, H - 44, 'CN', 19, true, COR.m); p.txt(X0, H - 61, '2O', 19, true, COR.m);
    p.ret(X0 + 28.5, H - 61, 5.5, 5.5, COR.v); p.ret(X0 + 42, H - 66, 2.2, 36, COR.v);
    p.txt(X0 + 54, H - 42, 'Cartório de Notas do 2º Ofício de Itabaiana/SE', 10.5, true, COR.m);
    p.txt(X0 + 54, H - 56, 'HUB CN2O  ·  RELATÓRIO MENSAL DE ATENDIMENTOS', 8, true, COR.v);
    p.txt(X1, H - 42, nomeMes(mes).replace(/^./, c => c.toUpperCase()), 10.5, true, COR.m, 'd');
    p.txt(X1, H - 56, 'Folha ' + n, 8, false, COR.m2, 'd');
    p.linha(X0, H - 76, X1, H - 76, COR.m18, 0.6);
  }
  function rodape(p, n, total) {
    p.linha(X0, 44, X1, 44, COR.m18, 0.6);
    p.txt(X0, 32, 'Cartório de Notas do 2º Ofício de Itabaiana/SE · Avenida Ivo de Carvalho, nº 441 · César Bravo | Tabelião · Uso interno — Time CN2O', 7, false, COR.m2);
    p.txt(X0, 22, 'Fonte: API do NextQS, coletada automaticamente pelo Hub CN2O · gerado em ' + geradoEm, 7, false, COR.m2);
    p.txt(X1, 22, 'Folha ' + n + ' de ' + total, 7, true, COR.m, 'd');
  }
  function titulo(p, y, num, t, sub) {
    p.txt(X0, y, num, 16, true, COR.v);
    p.txt(X0 + 28, y, t, 13, true, COR.m);
    if (sub) p.txt(X0 + 28, y - 13, sub, 8.5, false, COR.m2);
  }
  function colunas(p, x, y, w, h, rot, vals, cores) {
    const max = Math.max(1, ...vals);
    let e = Math.pow(10, Math.floor(Math.log10(max / 4))), passo = e;
    for (const s of [1, 2, 2.5, 5, 10]) { if (max / (s * e) <= 5) { passo = s * e; break; } }
    const topo = Math.ceil(max / passo) * passo, n = vals.length, esq = 30, pw = w - esq, ph = h - 26, slot = pw / n, bw = Math.min(26, slot * 0.7);
    for (let v = 0; v <= topo + 1e-9; v += passo) {
      const yy = y + 14 + v / topo * ph;
      p.linha(x + esq, yy, x + w, yy, COR.grade, 0.5);
      p.txt(x + esq - 4, yy - 2.5, fmtN(v), 7, false, COR.m2, 'd');
    }
    p.linha(x + esq, y + 14, x + w, y + 14, COR.m, 0.8);
    vals.forEach((v, i) => {
      const bh = v / topo * ph, bx = x + esq + i * slot + (slot - bw) / 2;
      if (bh > 0) p.ret(bx, y + 14, bw, bh, cores[i] || COR.m);
      if (v > 0 && bw >= 9) p.txt(bx + bw / 2, y + 16 + bh, fmtN(v), bw >= 16 ? 7 : 5.5, true, COR.m, 'c');
      if (rot[i]) p.txt(bx + bw / 2, y + 4, rot[i], n > 20 ? 6 : 7.5, false, COR.m2, 'c');
    });
  }
  function tabela(p, x, y, cols, lin, maxLin) {
    const alt = 15;
    p.ret(x, y - alt + 4, LW, alt, COR.m);
    let cx = x;
    cols.forEach(c => { p.txt(c.d ? cx + c.w - 6 : cx + 6, y - 7, c.t, 7.5, true, COR.br, c.d ? 'd' : null); cx += c.w; });
    y -= alt;
    lin.slice(0, maxLin).forEach((l, i) => {
      if (i % 2) p.ret(x, y - alt + 4, LW, alt, COR.zebra);
      let cx2 = x;
      cols.forEach((c, j) => {
        const t = p.caber(l[j], 8, j === 0, c.w - 12);
        p.txt(c.d ? cx2 + c.w - 6 : cx2 + 6, y - 7, t, 8, j === 0, COR.m, c.d ? 'd' : null);
        cx2 += c.w;
      });
      y -= alt;
    });
    if (lin.length > maxLin) { p.txt(x + 6, y - 7, '+ ' + (lin.length - maxLin) + ' outras linhas (ver o Hub)', 7.5, false, COR.m2); y -= alt; }
    p.linha(x, y + 4, x + LW, y + 4, COR.m, 0.8);
    return y;
  }

  // ---- folha 1
  const p1 = new Pagina(); pags.push(p1); cabecalho(p1, 1);
  const T = A.tot, TP = P.tot;
  p1.txt(X0, H - 112, 'Atendimentos de ' + nomeMes(mes), 22, true, COR.m);
  p1.txt(X0, H - 128, A.nd + ' dia(s) com atendimento · comparação com ' + nomeMes(mesAnterior) + (P.nd ? ' (' + P.nd + ' dias)' : ' (sem dados)'), 9.5, false, COR.m2);
  const tme = media(T.te, T.tw), tma = media(T.ta, T.aw), tmeP = media(TP.te, TP.tw), tmaP = media(TP.ta, TP.aw);
  const mdia = A.nd ? T.at / A.nd : null, mdiaP = P.nd ? TP.at / P.nd : null;
  const kpis = [
    { r: 'Senhas emitidas', v: fmtN(T.em), d: variacao(T.em, TP.em), bom: 0, c: COR.mp, s: '' },
    { r: 'Atendidas', v: fmtN(T.at), d: variacao(T.at, TP.at), bom: 0, c: COR.sa, s: T.em ? fmtP(T.at / T.em) + ' das emitidas' : '' },
    { r: 'Não atendidas', v: fmtN(T.na), d: variacao(T.na, TP.na), bom: -1, c: COR.ro, s: T.em ? fmtP(T.na / T.em) + ' das emitidas' : '' },
    { r: 'Espera média', v: fmtT(tme), d: variacao(tme, tmeP), bom: -1, c: COR.pa, s: 'da emissão à chamada' },
    { r: 'Atendimento médio', v: fmtT(tma), d: variacao(tma, tmaP), bom: 0, c: COR.mp, s: 'tempo no guichê' },
    { r: 'Média por dia', v: fmtN(mdia), d: variacao(mdia, mdiaP), bom: 0, c: COR.sa, s: 'atendidas por dia útil' }
  ];
  const kw = (LW - 20) / 3, kh = 66;
  kpis.forEach((k, i) => {
    const x = X0 + (i % 3) * (kw + 10), y = H - 148 - Math.floor(i / 3) * (kh + 10) - kh;
    p1.ret(x, y, kw, kh, k.c);
    p1.txt(x + 10, y + kh - 15, k.r.toUpperCase(), 7.5, true, COR.m);
    p1.txt(x + 10, y + kh - 38, k.v, 19, true, COR.m);
    let dl = 'sem comparação', dc = COR.m2;
    if (k.d != null) {
      dl = (k.d > 0 ? '+' : k.d < 0 ? '−' : '') + fmtP(Math.abs(k.d)) + ' sobre ' + MESES[+mesAnterior.slice(5, 7) - 1];
      if (k.bom === -1 && k.d > 0.05) dc = COR.v;
    }
    p1.txt(x + 10, y + 9, dl + (k.s ? '  ·  ' + k.s : ''), 7.5, k.bom === -1 && dc === COR.v, dc);
  });
  let y = H - 148 - 2 * (kh + 10) - 26;
  titulo(p1, y, '01', 'Atendidas por dia', 'Barras em vinho: os 3 dias de maior movimento. Sábados e domingos ficam vazios.');
  const ult = new Date(Date.UTC(y0, m0, 0)).getUTCDate(), vd = [], rd = [];
  for (let d = 1; d <= ult; d++) { const t = A.dias[mes + '-' + String(d).padStart(2, '0')]; vd.push(t ? t.at : 0); rd.push(String(d)); }
  const top3 = vd.slice().sort((a, b) => b - a)[2] || Infinity;
  colunas(p1, X0, y - 190, LW, 172, rd, vd, vd.map(v => (v > 0 && v >= top3 ? COR.v : COR.m)));
  y -= 222;
  const half = (LW - 24) / 2;
  titulo(p1, y, '02', 'Dia da semana', 'Média de atendidas por dia');
  const ids = [1, 2, 3, 4, 5].concat(A.dsem[6].n ? [6] : []);
  const mds = ids.map(i => (A.dsem[i].n ? A.dsem[i].s / A.dsem[i].n : 0)), mxs = Math.max(...mds);
  colunas(p1, X0, y - 170, half, 150, ids.map(i => DSEM[i]), mds, mds.map(v => (v === mxs && v > 0 ? COR.v : COR.m)));
  p1.txt(X0 + half + 24, y, '03', 16, true, COR.v);
  p1.txt(X0 + half + 52, y, 'Horário de pico', 13, true, COR.m);
  p1.txt(X0 + half + 52, y - 13, 'Senhas emitidas por hora de chegada', 8.5, false, COR.m2);
  const hs = Object.keys(A.horas).sort(), hv = hs.map(h => A.horas[h]), mxh = Math.max(0, ...hv);
  if (hs.length) colunas(p1, X0 + half + 24, y - 170, half, 150, hs, hv, hv.map(v => (v === mxh ? COR.v : COR.m)));
  else p1.txt(X0 + half + 52, y - 60, 'Sem dados de horário no mês.', 9, false, COR.m2);

  // ---- folha 2
  const p2 = new Pagina(); pags.push(p2); cabecalho(p2, 2);
  y = H - 108;
  titulo(p2, y, '04', 'Filas e serviços', 'Como cadastradas no NextQS (nomes parecidos aparecem separados) · ordenadas por atendidas');
  const lf = Object.keys(A.filas).map(k => ({ k, t: A.filas[k] })).sort((a, b) => b.t.at - a.t.at)
    .map(o => [o.k, fmtN(o.t.em), fmtN(o.t.at), fmtN(o.t.na), fmtT(media(o.t.te, o.t.tw)), fmtT(media(o.t.ta, o.t.aw))]);
  y = tabela(p2, X0, y - 26, [{ t: 'Fila / serviço', w: LW - 5 * 72 }, { t: 'Emitidas', w: 72, d: 1 }, { t: 'Atendidas', w: 72, d: 1 }, { t: 'Não atend.', w: 72, d: 1 }, { t: 'Espera média', w: 72, d: 1 }, { t: 'Atend. médio', w: 72, d: 1 }], lf, 18);
  y -= 30;
  titulo(p2, y, '05', 'Equipe', 'Atendimentos concluídos por atendente · ordenados por atendimentos');
  const la = Object.keys(A.ats).map(k => ({ k, t: A.ats[k] })).filter(o => o.t.at > 0).sort((a, b) => b.t.at - a.t.at)
    .map(o => [o.k, fmtN(o.t.at), fmtT(media(o.t.ta, o.t.aw)), fmtT(media(o.t.te, o.t.tw)), A.nd ? (Math.round(o.t.at / A.nd * 10) / 10).toString().replace('.', ',') : '—']);
  y = tabela(p2, X0, y - 26, [{ t: 'Atendente', w: LW - 4 * 90 }, { t: 'Atendimentos', w: 90, d: 1 }, { t: 'Tempo no guichê', w: 90, d: 1 }, { t: 'Espera das senhas', w: 90, d: 1 }, { t: 'Média por dia', w: 90, d: 1 }], la, 20);
  y -= 24;
  ['Notas',
    '• “Não atendidas”: senha marcada como ausente, ou emitida e nunca chamada até o fim do dia.',
    '• “Espera média”: da emissão da senha até a primeira chamada. “Atendimento médio”: do início ao fim do atendimento no guichê.',
    '• Números calculados a partir das senhas registradas no NextQS; senhas excluídas no sistema não entram na conta.'
  ].forEach((t, i) => { if (y - i * 12 > 60) p2.txt(X0, y - i * 12, t, i ? 7.5 : 8.5, !i, i ? COR.m2 : COR.m); });
  pags.forEach((p, i) => rodape(p, i + 1, pags.length));

  // ---- objetos do PDF
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'];
  const kids = [];
  pags.forEach(p => {
    const s = p.o.join('\n');
    objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
    const cid = objs.length;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cid} 0 R >>`);
    kids.push(objs.length + ' 0 R');
  });
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  objs.push(`<< /Title (${pdfStr('Atendimentos CN2O - ' + nomeMes(mes))}) /Author (Hub CN2O) /Creator (Hub CN2O · NextQS) >>`);
  const info = objs.length;
  let out = '%PDF-1.4\n%' + String.fromCharCode(226, 227, 207, 211) + '\n';
  const pos = [];
  objs.forEach((o, i) => { pos.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + pos.map(p => String(p).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return {
    pdf: Buffer.from(out, 'latin1'),
    nome: `Atendimentos CN2O — ${mes} (${nomeMes(mes)}).pdf`,
    resumo: { mes, senhas: T.em, atendidas: T.at, nao_atendidas: T.na, dias: A.nd, espera_media: tme, atendimento_medio: tma }
  };
}

module.exports = { montarPdf, agregar, nomeMes, fmtN, fmtT, fmtP };
