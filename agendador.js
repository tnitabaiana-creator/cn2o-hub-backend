// agendador.js — rotinas com hora marcada, no ciclo de vida do server.js.
//
//   07:00 todo dia      reconciliação: recarrega 3 dias de ações dos quadros (cobre
//                       webhook perdido ou desativado pelo Trello) e reprocessa o que
//                       ficou pendente
//   08:00 segunda-feira relatório SEMANAL (semana anterior, seg–dom)
//   08:00 1º dia útil   relatório MENSAL (mês anterior); dia útil pelo mesmo
//                       calendário das horas úteis (horas-uteis.js)
// Horário de Sergipe (America/Maceio). Sem node-cron: um relógio de 1 minuto pergunta
// "o que está devido agora?" — e quem garante o envio único é o banco
// (envios_relatorio), não a memória. Servidor que estava fora às 8h e sobe no mesmo dia
// ainda envia; em outro dia, não (o relatório atrasado sai pela rota manual).
//
// RELATORIOS_AGENDADOR=desligado desliga tudo (ex.: numa segunda instância).
'use strict';

const cal = require('./horas-uteis');

const HORA_RECONCILIACAO = 7 * 60;
const HORA_RELATORIOS = 8 * 60;

function primeiroDiaUtil(ano, mes, ehDiaUtil = cal.ehDiaUtil) {
  let d = `${ano}-${String(mes).padStart(2, '0')}-01`;
  while (!ehDiaUtil(d)) d = cal.somaDias(d, 1);
  return d;
}

// O que está devido no instante local L (saída de horas-uteis.local()).
function devidos(L, ehDiaUtil = cal.ehDiaUtil) {
  const out = [];
  if (L.minutos >= HORA_RECONCILIACAO) out.push({ tarefa: 'reconciliacao', dataRef: L.data });
  if (L.minutos >= HORA_RELATORIOS) {
    if (L.diaSemana === 1) out.push({ tarefa: 'semanal', dataRef: L.data });
    if (L.data === primeiroDiaUtil(L.ano, L.mes, ehDiaUtil)) out.push({ tarefa: 'mensal', dataRef: L.data });
  }
  return out;
}

const feitos = new Set();        // tarefa|data já resolvida neste processo (poupa o banco)
let rodando = false;
let avisoEmail = '';
let timer = null;

async function executar(t) {
  const chave = `${t.tarefa}|${t.dataRef}`;
  if (feitos.has(chave)) return;
  if (t.tarefa === 'reconciliacao') {
    feitos.add(chave);
    if (!process.env.TRELLO_KEY || !process.env.TRELLO_TOKEN) return;
    const r = await require('./carga_retroativa').carga({ desde: cal.somaDias(t.dataRef, -3), log: () => {} });
    console.log(`[agendador] reconciliação: ${r.novas} ação(ões) nova(s), ${r.cartoes} cartão(ões) revistos`);
    return;
  }
  const email = require('./relatorio-email');
  if (!email.configurado()) {
    if (avisoEmail !== t.dataRef) {
      console.error(`[agendador] relatório ${t.tarefa} devido, mas o e-mail não está configurado`);
      avisoEmail = t.dataRef;
    }
    return;
  }
  // 'aguardando' = erro com nova tentativa marcada, ou outra instância enviando agora
  const r = await require('./relatorios').enviarSeDevido(t.tarefa, t.dataRef);
  if (r.situacao !== 'aguardando') feitos.add(chave);
}

async function tick(agora = new Date()) {
  if (rodando) return;             // a carga pode passar de um minuto
  rodando = true;
  try {
    for (const t of devidos(cal.local(agora))) {
      try { await executar(t); }
      catch (e) { console.error(`[agendador] ${t.tarefa} ${t.dataRef}:`, e.message); }
    }
  } finally {
    rodando = false;
  }
}

function iniciar() {
  if (String(process.env.RELATORIOS_AGENDADOR || '').toLowerCase() === 'desligado') {
    console.log('[agendador] desligado por RELATORIOS_AGENDADOR');
    return;
  }
  if (timer) return;
  // logo após o boot: termina o que um reinício interrompeu
  setTimeout(() => {
    require('./rastreio').reprocessar()
      .then(n => { if (n) console.log(`[agendador] ${n} cartão(ões) pendente(s) reprocessado(s)`); })
      .catch(e => console.error('[agendador] reprocessar:', e.message))
      .finally(() => tick());
  }, 20e3).unref();
  timer = setInterval(() => { tick(); }, 60e3);
  timer.unref();
  console.log('[agendador] ativo: reconciliação 07:00, semanal seg 08:00, mensal 1º dia útil 08:00 (America/Maceio)');
}

function parar() { if (timer) clearInterval(timer); timer = null; }

module.exports = { iniciar, parar, tick, devidos, primeiroDiaUtil };
