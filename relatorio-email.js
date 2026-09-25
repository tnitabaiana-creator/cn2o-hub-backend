// relatorio-email.js — HTML, CSV e envio dos relatórios das escreventes.
//
// O HTML é de e-mail: tabelas e estilo inline (Gmail e Outlook ignoram quase todo
// CSS de <style>), largura máxima de 680 px e blocos que empilham no celular. As
// cores são as da identidade do CN2O (petróleo, rubi, dourado, papel). Fraunces e
// Archivo não carregam na maioria dos leitores de e-mail: ficam Georgia e Arial.
//
// Envio — o primeiro que estiver configurado:
//   1. Apps Script da serventia (apps-script/EnviarRelatorio.gs), sai pelo Gmail do
//      cartório. RELATORIO_EMAIL_WEBAPP_URL + RELATORIO_EMAIL_SECRET. Mesmo modelo da
//      ponte do Google Docs (docs.js): POST text/plain com o segredo no corpo.
//   2. Resend (API HTTP). RESEND_API_KEY + RELATORIO_EMAIL_DE (remetente de domínio
//      verificado na Resend).
//   3. RELATORIO_EMAIL_PROVEDOR=arquivo — grava .html e .csv em RELATORIO_SAIDA_DIR
//      (padrão ./relatorios-saida), para conferir sem mandar nada.
// A Railway bloqueia SMTP de saída nos planos Hobby, por isso não há nodemailer/SMTP.
//
// Destinatários: RELATORIO_EMAIL_PARA (vírgulas). Sem ela o relatório está em
// HOMOLOGAÇÃO: vai só para o endereço de teste e o assunto leva a marca.
'use strict';

const fs = require('fs');
const path = require('path');
const { dataBR } = require('./horas-uteis');

const EMAIL_TESTE = 'sergiolagofula2@gmail.com';
const C = {
  ruby: '#631325', petrol: '#202A3A', gold: '#C9A15A', goldSoft: '#E3CFA6', paper: '#F6F3EC',
  card: '#FFFFFF', ink: '#1C222E', ink2: '#5A6472', line: '#E4DED2', up: '#2F6E63', down: '#A33B4E',
  muted: '#B9C2CF', band: '#FBF9F4'
};
const SERIF = "Fraunces, Georgia, 'Times New Roman', serif";
const SANS = "Archivo, Arial, Helvetica, sans-serif";

function destinatarios() {
  const lista = String(process.env.RELATORIO_EMAIL_PARA || '').split(',').map(s => s.trim()).filter(Boolean);
  return lista.length ? { para: lista, homologacao: false } : { para: [EMAIL_TESTE], homologacao: true };
}

// ------------------------------------------------------------ formatação
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n, casas = 1) => (n == null || !Number.isFinite(Number(n)) ? '—'
  : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas }));
const horas = n => (n == null ? '—' : num(n) + ' h');
const pct = n => (n == null ? '—' : Math.round(n * 100) + '%');
function delta(v, curto = false) {
  if (v == null) return '';
  if (v === 0) return `<span style="color:${C.ink2}">${curto ? '=' : '= anterior'}</span>`;
  return `<span style="color:${v > 0 ? C.up : C.down};white-space:nowrap">${v > 0 ? '▲' : '▼'}${curto ? '' : ' '}${Math.abs(Math.round(v * 100))}%</span>`;
}
function corIndice(i) {
  if (i == null) return C.ink2;
  return i <= 0.9 ? C.up : i >= 1.1 ? C.down : C.ink;
}
const titulos = { semanal: 'Relatório semanal das escreventes', mensal: 'Relatório mensal das escreventes' };
function rotuloPeriodo(p) {
  return p.inicioISO.slice(0, 4) === p.fimISO.slice(0, 4)
    ? `${dataBR(p.inicioISO).slice(0, 5)} a ${dataBR(p.fimISO)}` : `${dataBR(p.inicioISO)} a ${dataBR(p.fimISO)}`;
}
function assunto(rel, homologacao) {
  return `${homologacao ? '[HOMOLOGAÇÃO] ' : ''}${titulos[rel.tipo]} · ${rotuloPeriodo(rel.periodo)}`;
}

// ------------------------------------------------------------ blocos do HTML
// cls 'hm' = coluna secundária, some no celular (a tabela tem de caber em 360 px)
const td = (conteudo, extra = '', cls = '') =>
  `<td${cls ? ` class="${cls}"` : ''} style="padding:8px 8px;border-bottom:1px solid ${C.line};font:13px/1.4 ${SANS};color:${C.ink};${extra}">${conteudo}</td>`;
const tdN = (conteudo, extra = '', cls = '') => td(conteudo, 'white-space:nowrap;' + extra, cls);
const th = (conteudo, cls = '') =>
  `<th${cls ? ` class="${cls}"` : ''} style="padding:8px 8px;border-bottom:2px solid ${C.gold};font:600 10px/1.3 ${SANS};letter-spacing:.06em;text-transform:uppercase;color:${C.ink2};text-align:left">${conteudo}</th>`;

function kpi(rotulo, valor, sub) {
  return `<td class="kpi" width="25%" valign="top" style="padding:6px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.band};border:1px solid ${C.line};border-top:3px solid ${C.ruby}">
      <tr><td style="padding:12px 14px">
        <div style="font:600 10px/1.3 ${SANS};letter-spacing:.14em;text-transform:uppercase;color:${C.ink2}">${rotulo}</div>
        <div style="font:600 26px/1.15 ${SERIF};color:${C.petrol};margin-top:6px">${valor}</div>
        <div style="font:12px/1.4 ${SANS};color:${C.ink2};margin-top:4px">${sub || '&nbsp;'}</div>
      </td></tr>
    </table></td>`;
}

function secao(titulo, corpo, subtitulo) {
  return `<tr><td class="px" style="padding:26px 28px 6px">
    <div style="font:600 11px/1.3 ${SANS};letter-spacing:.2em;text-transform:uppercase;color:${C.ruby}">${titulo}</div>
    ${subtitulo ? `<div style="font:13px/1.5 ${SANS};color:${C.ink2};margin-top:4px">${subtitulo}</div>` : ''}
  </td></tr>
  <tr><td class="px" style="padding:8px 28px 4px">${corpo}</td></tr>`;
}

const chip = (texto, cor, fundo) =>
  `<span style="display:inline-block;margin:0 6px 6px 0;padding:3px 9px;border-radius:12px;background:${fundo};color:${cor};font:600 12px/1.5 ${SANS}">${texto}</span>`;

function tabelaEquipe(rel) {
  const linhas = rel.escreventes.map(e => `<tr>
    ${td(`<b>${esc(e.nome)}</b>`)}
    ${tdN(`${e.concluidos} <span class="hm" style="font-size:11px">${delta(e.variacao, true)}</span>`)}
    ${tdN(num(e.pontos), '', 'hm')}
    ${tdN(horas(e.mediana_mesa))}
    ${tdN(horas(e.p75_mesa), '', 'hm')}
    ${tdN(horas(e.mediana_ativa))}
    ${tdN(`<b style="color:${corIndice(e.indice_custo)}">${num(e.indice_custo, 2)}</b>`)}
    ${tdN(pct(e.taxa_retorno))}
    ${tdN(String(e.pendencias.documental.em_aberto), '', 'hm')}
  </tr>`).join('');
  const f = `background:${C.band}`;
  return `<table class="tbm" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
    <tr>${th('Escrevente')}${th('Atos')}${th('Pontos', 'hm')}${th('Tempo total')}${th('Mais demorados', 'hm')}${th('Tempo de trabalho')}${th('Tempo vs. equipe')}${th('Voltou p/ ajuste')}${th('Pendências', 'hm')}</tr>
    ${linhas}
    <tr>
      ${td('<b>Equipe</b>', f)}
      ${tdN(`<b>${rel.equipe.concluidos}</b>`, f)}
      ${tdN(`<b>${num(rel.equipe.pontos)}</b>`, f, 'hm')}
      ${tdN(horas(rel.equipe.mediana_mesa), f)}
      ${tdN(horas(rel.equipe.p75_mesa), f, 'hm')}
      ${tdN(horas(rel.equipe.mediana_ativa), f)}
      ${tdN('1,00', `${f};color:${C.ink2}`)}
      ${tdN(pct(rel.equipe.taxa_retorno), f)}
      ${tdN(String(rel.equipe.pendencias.documental.em_aberto), f, 'hm')}
    </tr>
  </table>`;
}

function perfil(e, pesos) {
  const desc = t => esc((pesos[t] && pesos[t].descricao) || t);
  const fortes = e.afinidade.filter(a => a.indice >= 1.1).slice(0, 3);
  const fracos = e.afinidade.filter(a => a.indice <= 0.9).slice(-3).reverse();
  const mix = e.mix.length
    ? e.mix.map(m => chip(`${esc(m.tipo)} · ${m.n}`, C.petrol, '#EEF1F5')).join('') : `<span style="color:${C.ink2}">—</span>`;
  const af = [
    ...fortes.map(a => chip(`${esc(a.tipo)} ${num(a.indice, 2)}×`, C.up, '#E6F1EE')),
    ...fracos.map(a => chip(`${esc(a.tipo)} ${num(a.indice, 2)}×`, C.down, '#F6E7EA'))
  ].join('') || `<span style="font:12px/1.5 ${SANS};color:${C.ink2}">ainda sem atos suficientes (mínimo de 3 do mesmo tipo em 90 dias)</span>`;
  const wip = e.wip
    ? `${e.wip.total} cartão(ões) no quadro agora${e.wip.atrasados ? ` · <b style="color:${C.down}">${e.wip.atrasados} com prazo vencido</b>` : ''}`
    : '';
  const tipsAf = fortes.map(a => `${desc(a.tipo)}`).join(', ');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px;border:1px solid ${C.line};border-left:4px solid ${C.gold}">
    <tr><td style="padding:14px 16px">
      <div style="font:600 19px/1.2 ${SERIF};color:${C.petrol}">${esc(e.nome)}</div>
      <div style="font:13px/1.6 ${SANS};color:${C.ink};margin-top:6px">
        <b>${e.concluidos}</b> ato(s) · <b>${num(e.pontos)}</b> pontos · tempo total ${horas(e.mediana_mesa)} (mais demorados ${horas(e.p75_mesa)}) ·
        tempo de trabalho ${horas(e.mediana_ativa)} · tempo vs. equipe <b style="color:${corIndice(e.indice_custo)}">${num(e.indice_custo, 2)}</b> ·
        voltou p/ ajuste ${pct(e.taxa_retorno)}
      </div>
      ${e.leitura ? `<div style="font:italic 13px/1.5 ${SERIF};color:${C.ink2};margin-top:6px">${esc(e.leitura)}</div>` : ''}
      <div style="font:600 10px/1.3 ${SANS};letter-spacing:.14em;text-transform:uppercase;color:${C.ink2};margin:12px 0 6px">Atos do período</div>
      <div>${mix}</div>
      <div style="font:600 10px/1.3 ${SANS};letter-spacing:.14em;text-transform:uppercase;color:${C.ink2};margin:8px 0 6px">Onde rende mais e menos (90 dias)${tipsAf ? ` · rende mais em ${tipsAf}` : ''}</div>
      <div>${af}</div>
      <div style="font:12px/1.5 ${SANS};color:${C.ink2};margin-top:6px">
        Pendências documentais: ${e.pendencias.documental.abertas} aberta(s) no período, ${e.pendencias.documental.em_aberto} em aberto no fim ·
        ajustes: ${e.pendencias.ajuste.abertas}${wip ? ' · ' + wip : ''}
      </div>
    </td></tr></table>`;
}

function tabelaTipos(rel) {
  if (!rel.por_tipo.length) return `<div style="font:13px ${SANS};color:${C.ink2}">Nenhum ato concluído no período.</div>`;
  const linhas = rel.por_tipo.map(t => `<tr>
    ${td(`<b>${esc(t.tipo)}</b><div style="font-size:11px;color:${C.ink2}">${esc(t.descricao)}</div>`)}
    ${tdN(String(t.n))}
    ${tdN(horas(t.mediana_ativa))}
    ${tdN(horas(t.p75_ativa), '', 'hm')}
    ${tdN(horas(t.mediana_mesa), '', 'hm')}
    ${tdN(`${horas(t.referencia)}<div style="font-size:11px;color:${C.ink2}">${t.fonte_referencia === 'equipe' ? 'pela equipe, 90 dias' : 'pela tabela'}</div>`)}
  </tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
    <tr>${th('Tipo de ato')}${th('Atos')}${th('Tempo de trabalho')}${th('Mais demorados', 'hm')}${th('Tempo total', 'hm')}${th('Tempo esperado')}</tr>${linhas}
  </table>`;
}

function html(rel, { homologacao = false, geradoEm = new Date(), expediente = '08:00-12:00, 13:00-17:00' } = {}) {
  const eq = rel.equipe;
  const nomePer = rel.tipo === 'semanal' ? 'semana' : 'mês';
  const pesos = rel.pesos || {};
  const gerado = new Date(geradoEm).toLocaleString('pt-BR', { timeZone: 'America/Maceio', dateStyle: 'short', timeStyle: 'short' });
  const preheader = `${eq.concluidos} atos concluídos · tempo total típico ${horas(eq.mediana_mesa)} · voltou p/ ajuste ${pct(eq.taxa_retorno)}`;
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">
<title>${esc(assunto(rel, homologacao))}</title>
<style>
@media (max-width:620px){ .px{padding-left:12px!important;padding-right:12px!important}
  .kpi{display:block!important;width:100%!important;box-sizing:border-box} .h1{font-size:24px!important}
  .hm{display:none!important} .tbm td,.tbm th{padding-left:5px!important;padding-right:5px!important} }
</style></head>
<body style="margin:0;padding:0;background:${C.paper}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.paper}"><tr><td align="center" style="padding:20px 6px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;table-layout:fixed;background:${C.card};border:1px solid ${C.line}">
  ${homologacao ? `<tr><td style="background:${C.goldSoft};padding:8px 28px;font:600 12px/1.4 ${SANS};color:${C.petrol}">HOMOLOGAÇÃO — enviado somente para o endereço de teste. Defina RELATORIO_EMAIL_PARA para os destinatários reais.</td></tr>` : ''}
  <tr><td class="px" style="background:${C.petrol};padding:28px 28px 22px">
    <div style="font:600 11px/1.3 ${SANS};letter-spacing:.22em;text-transform:uppercase;color:${C.gold}">CN2O · 2º Ofício de Notas de Itabaiana/SE</div>
    <div class="h1" style="font:600 30px/1.15 ${SERIF};color:#FFFFFF;margin-top:8px">${esc(titulos[rel.tipo])}</div>
    <div style="font:14px/1.5 ${SANS};color:${C.muted};margin-top:6px">${esc(rotuloPeriodo(rel.periodo))} · horas úteis</div>
  </td></tr>
  <tr><td style="height:4px;line-height:4px;font-size:0;background:${C.ruby}">&nbsp;</td></tr>
  <tr><td class="px" style="padding:18px 22px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${kpi('Atos concluídos', String(eq.concluidos), `${delta(eq.variacao)} <span style="color:${C.ink2}">vs ${nomePer} anterior (${eq.concluidos_anterior})</span>`)}
      ${kpi('Pontos', num(eq.pontos), 'soma dos pesos por ato')}
      ${kpi('Tempo total típico', horas(eq.mediana_mesa), `mais demorados: ${horas(eq.p75_mesa)}`)}
      ${kpi('Voltou p/ ajuste', pct(eq.taxa_retorno), `${eq.com_retorno} de ${eq.concluidos} ato(s)`)}
    </tr></table>
  </td></tr>
  ${secao('Equipe', tabelaEquipe(rel), 'Tempo vs. equipe: 1,00 = igual à equipe; 0,80 = 20% mais rápida; 1,20 = 20% mais lenta.')}
  ${secao('Perfil de cada escrevente', rel.escreventes.map(e => perfil(e, pesos)).join(''))}
  ${secao('Por tipo de ato', tabelaTipos(rel))}
  <tr><td class="px" style="padding:22px 28px 26px">
    <div style="border-top:1px solid ${C.line};padding-top:14px;font:12px/1.6 ${SANS};color:${C.ink2}">
      <b style="color:${C.ink}">Como ler.</b> Tudo em horas úteis (expediente ${esc(expediente)}, seg. a sex., sem feriados).
      <b>Tempo total</b>: da chegada do cartão ao quadro da escrevente até o Finalizado, contando as esperas; é o valor típico (metade dos atos sai mais rápido).
      <b>Mais demorados</b>: 3 em cada 4 atos saem dentro desse tempo; 1 em cada 4 demora mais.
      <b>Tempo de trabalho</b>: só o tempo nas mãos dela (Revisar Minuta e Ajuste/Retorno) — conferência, pendência de documento e assinatura não contam.
      <b>Tempo vs. equipe</b>: o tempo de trabalho dela comparado ao da equipe no mesmo tipo de ato (90 dias).
      <b>Onde rende mais e menos</b>: quantas vezes ela é mais rápida que a equipe num tipo de ato — em verde onde rende mais, em vinho onde rende menos (mín. 3 atos dela em 90 dias).
      <b>Tempo esperado</b>: o tempo de trabalho normal daquele tipo de ato, pela equipe nos últimos 90 dias ou, sem atos suficientes, pela tabela.
      <b>Pontos</b>: peso de cada tipo de ato.
      ${eq.sem_historico ? `${eq.sem_historico} ato(s) do período entraram na contagem mas não nos tempos: chegaram ao quadro antes de o acompanhamento começar.` : ''}
      <br><br>Gerado automaticamente pelos Relatórios das Escreventes do CN2O em ${esc(gerado)}. Detalhe por ato no anexo CSV.
    </div>
  </td></tr>
</table></td></tr></table></body></html>`;
}

function texto(rel, homologacao) {
  const eq = rel.equipe;
  const linhas = [
    assunto(rel, homologacao), '',
    `Equipe: ${eq.concluidos} atos (${eq.concluidos_anterior} no período anterior), ${num(eq.pontos)} pontos,`,
    `tempo total típico ${horas(eq.mediana_mesa)} (mais demorados ${horas(eq.p75_mesa)}), voltou p/ ajuste ${pct(eq.taxa_retorno)}.`, ''
  ];
  for (const e of rel.escreventes) {
    linhas.push(`${e.nome}: ${e.concluidos} atos, ${num(e.pontos)} pts, tempo total ${horas(e.mediana_mesa)}, tempo de trabalho ${horas(e.mediana_ativa)}, tempo vs. equipe ${num(e.indice_custo, 2)}. ${e.leitura}`);
  }
  linhas.push('', 'Detalhe por ato no anexo CSV.');
  return linhas.join('\n');
}

// ------------------------------------------------------------ CSV (Excel pt-BR)
function csv(conclusoes, pesos, nomes) {
  const campo = v => {
    const s = v == null ? '' : String(v);
    return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const dec = v => (v == null ? '' : String(Math.round(v * 100) / 100).replace('.', ','));
  const dt = v => (v ? new Date(v).toLocaleString('pt-BR', { timeZone: 'America/Maceio' }) : '');
  // v1.38.4: cabeçalhos com os nomes do e-mail (horas úteis); a ordem das colunas não mudou
  const cab = ['Escrevente', 'Protocolo', 'Tipo de ato', 'Descrição do tipo', 'Pontos', 'Chegada ao quadro', 'Concluído em',
    'Tempo total (h)', 'Tempo de trabalho (h)', 'Conferência (h)', 'Pendência (h)', 'Assinatura (h)', 'Voltou p/ ajuste (vezes)',
    'Reaberturas', 'Tempos completos', 'Cartão'];
  const linhas = conclusoes.map(c => [
    (nomes && nomes[c.escrevente]) || c.escrevente, c.protocolo, c.tipo_ato,
    (pesos[c.tipo_ato] && pesos[c.tipo_ato].descricao) || '', dec((pesos[c.tipo_ato] || {}).peso),
    dt(c.entrada_mesa_em), dt(c.concluido_em), dec(c.horas_mesa), dec(c.horas_ativas), dec(c.horas_conferencia),
    dec(c.horas_pendencia), dec(c.horas_assinatura), c.retornos, c.reaberturas,
    c.historico_completo ? 'sim' : 'não', c.card_short ? `https://trello.com/c/${c.card_short}` : ''
  ].map(campo).join(';'));
  return '﻿' + [cab.join(';'), ...linhas].join('\r\n') + '\r\n';
}

// ------------------------------------------------------------ envio
function provedor() {
  const p = String(process.env.RELATORIO_EMAIL_PROVEDOR || '').trim().toLowerCase();
  if (p) return p;
  if (process.env.RELATORIO_EMAIL_WEBAPP_URL && process.env.RELATORIO_EMAIL_SECRET) return 'appsscript';
  if (process.env.RESEND_API_KEY) return 'resend';
  return null;
}
const configurado = () => !!provedor();

async function comPrazo(url, opcoes, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opcoes, signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}

// mensagem: { para[], assunto, html, texto, anexos: [{ nome, tipo, conteudo (string|Buffer) }] }
async function enviar(msg) {
  const prov = provedor();
  // v1.39: anexo binário (o PDF dos atendimentos) vem como Buffer; texto (o CSV), como string
  const anexos = (msg.anexos || []).map(a => ({
    nome: a.nome, tipo: a.tipo,
    base64: (Buffer.isBuffer(a.conteudo) ? a.conteudo : Buffer.from(a.conteudo, 'utf8')).toString('base64')
  }));
  if (prov === 'appsscript') {
    const r = await comPrazo(process.env.RELATORIO_EMAIL_WEBAPP_URL, {
      method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ segredo: process.env.RELATORIO_EMAIL_SECRET, versao: 1, para: msg.para,
        assunto: msg.assunto, html: msg.html, texto: msg.texto, remetente: 'CN2O · Relatórios', anexos })
    }, Number(process.env.RELATORIO_EMAIL_TIMEOUT_MS) || 60000);
    const corpo = await r.text();
    let j = null; try { j = JSON.parse(corpo); } catch (_) { /* HTML de erro do Google */ }
    if (!r.ok || !j || !j.ok) {
      const detalhe = (j && j.erro) || (!j && corpo.includes('<html') ? 'resposta não-JSON (autorização Google ou URL inválida)' : `HTTP ${r.status}`);
      throw new Error(`Apps Script: ${detalhe}`);
    }
    return { provedor: prov, id: j.id || null };
  }
  if (prov === 'resend') {
    if (!process.env.RELATORIO_EMAIL_DE) throw new Error('Resend: defina RELATORIO_EMAIL_DE (remetente verificado)');
    const r = await comPrazo('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.RELATORIO_EMAIL_DE, to: msg.para, subject: msg.assunto,
        html: msg.html, text: msg.texto, attachments: anexos.map(a => ({ filename: a.nome, content: a.base64 })) })
    }, 30000);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Resend: ${j.message || `HTTP ${r.status}`}`);
    return { provedor: prov, id: j.id || null };
  }
  if (prov === 'arquivo') {
    const dir = path.resolve(process.env.RELATORIO_SAIDA_DIR || 'relatorios-saida');
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, msg.assunto.replace(/[^\w\-]+/g, '_').slice(0, 90));
    fs.writeFileSync(base + '.html', msg.html);
    for (const a of msg.anexos || []) fs.writeFileSync(`${base}__${a.nome}`, a.conteudo);
    return { provedor: prov, id: base + '.html' };
  }
  throw new Error('e-mail dos relatórios não configurado (RELATORIO_EMAIL_WEBAPP_URL/SECRET ou RESEND_API_KEY)');
}

module.exports = { html, texto, csv, assunto, enviar, configurado, provedor, destinatarios, EMAIL_TESTE, rotuloPeriodo };
