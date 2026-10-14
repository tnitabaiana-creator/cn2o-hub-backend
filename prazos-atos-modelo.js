'use strict';
const cal = require('./horas-uteis');
const CADASTRO = '693aafe273e4860efe413736';
const PROTOCOLO = '692e0379fa55156e778f27ef';
const VERSAO = '2026-10-14.3';
const normalizar = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
function regra(dados, labels = []) {
  const nomes = labels.map(l => normalizar(l.name));
  const f = dados.bandeiras || [];
  const vendedor = f.some(b => ['verde', 'amarelo', 'rosa'].includes(b)) ||
    nomes.some(n => ['loteador/incorporador', 'construtor', 'santa monica'].includes(n));
  const advogado = f.includes('roxo') || nomes.includes('advogado');
  const tabela = {
    'CV-Urbano': [vendedor ? 5 : 10, true], 'CV-Rural': [vendedor ? 5 : 10, true],
    DOA: [vendedor ? 5 : 8, true], PER: [vendedor ? 5 : 8, true],
    INV: [4, true], CDH: [advogado ? 4 : 7, true], TEST: [5, true],
    CDP: [3, false], CERT: [5, true]
  };
  const [dias, uteis] = tabela[dados.ato] || [8, true];
  return { dias, uteis, versao: VERSAO, ato: dados.ato, regra_legada: !tabela[dados.ato] };
}
function vencimento(inicio, r, calendario = cal.calendario) {
  if (!Number.isFinite(Date.parse(inicio))) throw Error('inicio_invalido');
  let dia = cal.local(inicio).data, n = 0;
  while (n < r.dias) { dia = cal.somaDias(dia, 1); if (!r.uteis || calendario.ehDiaUtil(dia)) n++; }
  return new Date(cal.meiaNoiteLocal(cal.somaDias(dia, 1)).getTime() - 1000).toISOString();
}
function chegada(a) {
  const d = a.data || {};
  if (a.type === 'updateCard' && d.listAfter) return { board: d.board?.id, lista: d.listAfter.id };
  if (['createCard', 'moveCardToBoard', 'copyCard', 'emailCard', 'convertToCardFromCheckItem'].includes(a.type))
    return { board: d.board?.id, lista: d.list?.id };
  return null;
}
function primeiroInicio(acoes, dados, criadoEm) {
  // Certidões seguem o fluxo próprio do quadro 04, sem passar pelo Cadastro.
  if (dados.ato === 'CERT') return { em: new Date(criadoEm).toISOString(), evidencia: 'protocolo_certidao' };
  const entrada = [...acoes].sort((a,b) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id))
    .find(a => { const p = chegada(a); return p?.board === PROTOCOLO && p.lista === CADASTRO; });
  return entrada ? { em: new Date(entrada.date).toISOString(), evidencia: entrada.id } : null;
}
function limitarUrgencia(estado, card, acoes, agora, calendario = cal.calendario) {
  if (!(card.labels || []).some(l => normalizar(l.name) === 'urgente')) return estado;
  const inclusoes = acoes.filter(a => a.type === 'addLabelToCard' && normalizar(a.data?.label?.name) === 'urgente')
    .sort((a,b) => Date.parse(b.date) - Date.parse(a.date));
  const quando = inclusoes[0]?.date || estado.urgente_em || agora.toISOString();
  const inicio = new Date(Math.max(Date.parse(estado.inicio), Date.parse(quando))).toISOString();
  const limite = vencimento(inicio, { dias: 2, uteis: true }, calendario);
  return { ...estado, urgente_em: quando, vencimento: new Date(Math.min(Date.parse(estado.vencimento), Date.parse(limite))).toISOString() };
}
function situacao(estado, agora, calendario = cal.calendario) {
  const fim = Date.parse(estado.vencimento), t = agora.getTime();
  if (t > fim) return { cor: 'vermelho', texto: '🔴 Prazo vencido', aviso: 'vencido' };
  const hoje = cal.local(agora).data, ultimo = cal.local(estado.vencimento).data;
  let restantes = 0;
  for (let d = cal.somaDias(hoje, 1); d <= ultimo; d = cal.somaDias(d, 1))
    if (!estado.regra.uteis || calendario.ehDiaUtil(d)) restantes++;
  const unidade = estado.regra.uteis ? 'úteis' : 'corridos';
  if (hoje === ultimo) return { cor: 'amarelo', texto: '🟡 Vence hoje', aviso: 'hoje' };
  if (restantes <= 2)
    return { cor: 'amarelo', texto: `🟡 ${restantes} dia(s) ${unidade} restantes`, aviso: restantes === 1 ? 'vespera' : 'vencendo' };
  return { cor: 'verde', texto: `🟢 ${restantes} dia(s) ${unidade} restantes`, aviso: null };
}
function fase(nome, closed) {
  if (closed) return 'arquivado';
  const n = normalizar(nome).replace(/[✔✅]/g, '').trim();
  if (/^(finalizado|finalizados|concluido|concluidos)$/.test(n)) return 'concluido';
  if (/^(arquivar|arquivado|arquivo geral)/.test(n)) return 'arquivado';
  if (n.includes('assinatura')) return 'assinatura';
  return 'ativo';
}
function marcos(vencimento, calendario = cal.calendario) {
  const dia = cal.local(vencimento).data;
  let d = dia; const anteriores = [];
  while (anteriores.length < 2) { d = cal.somaDias(d, -1); if (calendario.ehDiaUtil(d)) anteriores.push(d); }
  return [{ dia:anteriores[1], tipo:'dois_dias', rotulo:'Vence em 2 dias úteis' },
    { dia:anteriores[0], tipo:'vespera', rotulo:'Vence no próximo dia útil' },
    { dia, tipo:'hoje', rotulo:'Vence hoje' }];
}
function avisoDoDia(vencimento, agora, calendario = cal.calendario) {
  const hoje = cal.local(agora).data;
  if (agora.getTime() > Date.parse(vencimento)) return 'vencido';
  return marcos(vencimento,calendario).find(m=>m.dia === hoje)?.tipo || null;
}
module.exports = { CADASTRO, PROTOCOLO, VERSAO, normalizar, regra, vencimento, chegada, primeiroInicio, limitarUrgencia, situacao, fase, marcos, avisoDoDia };
