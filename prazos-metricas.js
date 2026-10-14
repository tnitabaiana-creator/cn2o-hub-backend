'use strict';
const cal = require('./horas-uteis');
const SCHEMA = `CREATE TABLE IF NOT EXISTS prazos_metricas (
  chave TEXT PRIMARY KEY, tipo TEXT NOT NULL, card_id TEXT NOT NULL, protocolo INTEGER,
  responsavel_login TEXT, ato TEXT, inicio TIMESTAMPTZ NOT NULL, vencimento TIMESTAMPTZ NOT NULL,
  concluido_em TIMESTAMPTZ NOT NULL, no_prazo BOOLEAN NOT NULL, horas_uteis NUMERIC NOT NULL,
  atraso_horas_uteis NUMERIC NOT NULL, evidencia TEXT NOT NULL,
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT now()
); CREATE INDEX IF NOT EXISTS prazos_metricas_periodo ON prazos_metricas(tipo,concluido_em,responsavel_login);`;
function snapshot(x, calendario=cal.calendario) {
  const inicio=new Date(x.inicio),fim=new Date(x.concluido_em),prazo=new Date(x.vencimento);
  if (![inicio,fim,prazo].every(d=>Number.isFinite(d.getTime())) || fim<inicio || !x.evidencia) throw Error('conclusao_sem_evidencia');
  return {...x,inicio:inicio.toISOString(),concluido_em:fim.toISOString(),vencimento:prazo.toISOString(),
    no_prazo:fim<=prazo,horas_uteis:calendario.horasUteis(inicio,fim),
    atraso_horas_uteis:fim>prazo?calendario.horasUteis(prazo,fim):0};
}
async function registrar(client,x) {
  const s=snapshot(x);
  await client.query(`INSERT INTO prazos_metricas(chave,tipo,card_id,protocolo,responsavel_login,ato,inicio,vencimento,concluido_em,no_prazo,horas_uteis,atraso_horas_uteis,evidencia)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(chave) DO NOTHING`,
    [s.chave,s.tipo,s.card_id,s.protocolo||null,s.responsavel_login||null,s.ato||null,s.inicio,s.vencimento,s.concluido_em,s.no_prazo,s.horas_uteis,s.atraso_horas_uteis,s.evidencia]);
  return s;
}
function resumir(linhas) {
  const grupos=new Map();
  function acumular(g,r){g.concluidos++;if(r.no_prazo)g.no_prazo++;else g.atrasados++;g.horas+=Number(r.horas_uteis);g.atraso+=Number(r.atraso_horas_uteis);g.maior_atraso=Math.max(g.maior_atraso,Number(r.atraso_horas_uteis));}
  const novo=(tipo,responsavel,ato)=>({tipo,responsavel,ato,concluidos:0,no_prazo:0,atrasados:0,horas:0,atraso:0,maior_atraso:0});
  const totais={ato:novo('ato',null,null),setor:novo('setor',null,null)};
  for(const r of linhas){if(!totais[r.tipo])continue;acumular(totais[r.tipo],r);const k=[r.tipo,r.responsavel_login||'',r.ato||''].join('|');if(!grupos.has(k))grupos.set(k,novo(r.tipo,r.responsavel_login||null,r.ato||null));acumular(grupos.get(k),r);}
  const finalizar=g=>({...g,percentual_no_prazo:g.concluidos?Math.round(10000*g.no_prazo/g.concluidos)/100:null,
    media_horas_uteis:g.concluidos?g.horas/g.concluidos:null,atraso_medio_horas_uteis:g.atrasados?g.atraso/g.atrasados:0});
  return {totais:Object.fromEntries(Object.entries(totais).map(([k,v])=>[k,finalizar(v)])),por_responsavel_ato:[...grupos.values()].map(finalizar)};
}
function dataValida(v){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T12:00:00Z'))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v;}
async function consultar(pool,de,ate) {
  if(!dataValida(de)||!dataValida(ate)||ate<de||(Date.parse(ate)-Date.parse(de))/86400000>366)throw Object.assign(Error('informe um período válido de até 366 dias'),{status:400});
  const r=await pool.query('SELECT * FROM prazos_metricas WHERE concluido_em >= $1 AND concluido_em < $2 ORDER BY concluido_em,card_id',[cal.meiaNoiteLocal(de),cal.meiaNoiteLocal(cal.somaDias(ate,1))]);
  return {de,ate,...resumir(r.rows),detalhes:r.rows,
    criterio:'Conclusão comprovada no Trello; primeiro encerramento por cartão no ato e por ciclo no setor. Sem início ou conclusão comprovados, não entra no percentual.',
    cobertura:'Somente relógios registrados após a ativação. Ausência de amostra não significa 100% de cumprimento.'};
}
function html(r) {
  if(!r||r.indisponivel)return '<section><h3>Relógio do Ato e prazo setorial</h3><p>Estatística de prazos ainda indisponível.</p></section>';
  const esc=s=>String(s==null?'—':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  return '<section><h3>Relógio do Ato e prazo setorial</h3><table><thead><tr><th>Controle</th><th>Concluídos</th><th>No prazo</th><th>Atrasados</th><th>Cumprimento</th></tr></thead><tbody>'+Object.entries(r.totais).map(([k,t])=>'<tr><td>'+esc(k==='ato'?'Prazo do ato':'Setor · 8h úteis')+'</td><td>'+t.concluidos+'</td><td>'+t.no_prazo+'</td><td>'+t.atrasados+'</td><td>'+(t.percentual_no_prazo==null?'Sem amostra':t.percentual_no_prazo+'%')+'</td></tr>').join('')+'</tbody></table><p>'+esc(r.criterio)+'</p><p>'+esc(r.cobertura)+'</p></section>';
}
function texto(r){if(!r||r.indisponivel)return 'Controle de prazos: indisponível.';return 'CONTROLE DE PRAZOS\n'+Object.entries(r.totais).map(([k,t])=>`${k==='ato'?'Atos':'Setor 8h úteis'}: ${t.concluidos} concluídos; ${t.no_prazo} no prazo; ${t.atrasados} atrasados; cumprimento ${t.percentual_no_prazo==null?'sem amostra':t.percentual_no_prazo+'%'}.`).join('\n')+'\n'+r.cobertura;}
function csv(r){
  if(!r||r.indisponivel)return '\r\nControle de prazos;Indisponível\r\n';
  const cel=v=>'"'+String(v==null?'':v).replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';
  return '\r\nCONTROLE DE PRAZOS\r\nTipo;Protocolo;Responsável;Ato;Início;Vencimento;Conclusão;No prazo;Horas úteis;Atraso em horas úteis\r\n'+r.detalhes.map(x=>[x.tipo,x.protocolo,x.responsavel_login,x.ato,x.inicio,x.vencimento,x.concluido_em,x.no_prazo?'Sim':'Não',x.horas_uteis,x.atraso_horas_uteis].map(cel).join(';')).join('\r\n')+'\r\n';
}
module.exports={SCHEMA,snapshot,registrar,resumir,consultar,html,texto,csv};
