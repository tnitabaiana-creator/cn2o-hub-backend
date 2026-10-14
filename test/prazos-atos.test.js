'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../prazos-atos-modelo');
const { criarCalendario } = require('../horas-uteis');
const calendario = criarCalendario({ feriadosExtra: '2026-10-16' });
const NOW = new Date('2026-10-14T18:00:00Z');
const cardId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const action = (id,date,lista,board=M.PROTOCOLO) => ({ id: String(id).padStart(24,'0'), date, type:'updateCard',
  data:{ card:{id:cardId}, board:{id:board},listAfter:{id:lista} } });
test('matriz aprovada, sem alterar doação e permuta legadas',()=>{
  for(const ato of ['CV-Urbano','CV-Rural']) {
    assert.equal(M.regra({ato}).dias,10);
    for(const b of ['verde','amarelo']) assert.equal(M.regra({ato,bandeiras:[b]}).dias,5);
  }
  for(const ato of ['TEST','CERT']) assert.equal(M.regra({ato}).dias,5);
  for(const ato of ['DOA','PER']) assert.equal(M.regra({ato}).dias,8);
  assert.equal(M.regra({ato:'INV'}).dias,4);
  assert.equal(M.regra({ato:'CDH'}).dias,7);
  assert.equal(M.regra({ato:'CDH',bandeiras:['roxo']}).dias,4);
  assert.equal(M.regra({ato:'CDP'}).uteis,false);
});
test('Santa Mônica: somente compra e venda tem três dias corridos, inclusive feriado e domingo',()=>{
  for (const ato of ['CV-Urbano','CV-Rural']) {
    for (const [dados,labels] of [[{ato,bandeiras:['rosa']},[]],[{ato},[{name:'Santa Mônica'}]]]) {
      const r=M.regra(dados,labels);
      assert.equal(r.dias,3); assert.equal(r.uteis,false);
      assert.equal(M.vencimento('2026-10-15T12:00:00Z',r,calendario),'2026-10-19T02:59:59.000Z');
    }
    for (const name of ['Construtor','Loteador/Incorporador']) {
      const r=M.regra({ato},[{name}]); assert.equal(r.dias,5); assert.equal(r.uteis,true);
    }
  }
  for (const ato of ['DOA','PER','TEST','CERT']) {
    const r=M.regra({ato},[{name:'Santa Mônica'}]); assert.equal(r.dias,5); assert.equal(r.uteis,true);
  }
});
test('retificação alcança relógio ativo sem reiniciar a entrada ou prorrogar urgência',()=>{
  const estado={inicio:'2026-10-15T12:00:00Z',vencimento:'2026-10-23T02:59:59.000Z',regra:M.regra({ato:'CV-Urbano',bandeiras:['verde']})};
  const dados={ato:'CV-Urbano'}, labels=[{name:'Santa Mônica'}];
  const novo=M.aplicarExcecaoSantaMonica(estado,dados,labels,calendario);
  assert.equal(novo.inicio,estado.inicio); assert.equal(novo.vencimento,'2026-10-19T02:59:59.000Z');
  assert.equal(novo.regra.uteis,false);
  const urgente={...estado,vencimento:'2026-10-17T02:59:59.000Z'};
  assert.equal(M.aplicarExcecaoSantaMonica(urgente,dados,labels,calendario).vencimento,urgente.vencimento);
  assert.equal(M.aplicarExcecaoSantaMonica(estado,dados,[],calendario),estado);
});
test('dias úteis excluem o dia inicial, finais de semana e feriado; limite às 23:59:59 local',()=>{
  assert.equal(M.vencimento(NOW.toISOString(),{dias:2,uteis:true},calendario),'2026-10-20T02:59:59.000Z');
  assert.equal(M.vencimento('2026-10-17T02:30:00Z',{dias:1,uteis:true},calendario),'2026-10-20T02:59:59.000Z');
});
test('CDP usa dias corridos inclusive domingo',()=>{
  assert.equal(M.vencimento('2026-10-15T12:00:00Z',{dias:3,uteis:false},calendario),'2026-10-19T02:59:59.000Z');
});
test('nenhuma fase anterior inicia a contagem, e retornos conservam a primeira entrada',()=>{
  const antes=[action(1,'2026-10-10T12:00:00Z','692e04b1eb7cbc358301a32e'),action(2,'2026-10-13T12:00:00Z','692e04c90ddc9150fc7ee25c')];
  assert.equal(M.primeiroInicio(antes,{ato:'CV-Urbano'}),null);
  const atos=[action(4,'2026-10-20T12:00:00Z',M.CADASTRO),...antes,action(3,NOW.toISOString(),M.CADASTRO)];
  assert.equal(M.primeiroInicio(atos,{ato:'CV-Urbano'}).em,NOW.toISOString());
  assert.equal(M.primeiroInicio([action(1,NOW.toISOString(),M.CADASTRO,'outro')],{ato:'INV'}),null);
});
test('certidão inicia pelo protocolo, no fluxo próprio',()=>{
  assert.equal(M.primeiroInicio([],{ato:'CERT'},NOW).em,NOW.toISOString());
});
test('urgência tardia limita a 2 dias úteis e nunca prorroga vencimento menor',()=>{
  const inicial={inicio:NOW.toISOString(),vencimento:'2026-11-01T02:59:59.000Z',regra:M.regra({ato:'CV-Urbano'})};
  const card={labels:[{name:'URGENTE'}]};
  const a=[{type:'addLabelToCard',date:'2026-10-20T12:00:00Z',data:{label:{name:'Urgente'}}}];
  const novo=M.limitarUrgencia(inicial,card,a,new Date('2026-10-21T12:00:00Z'));
  assert.equal(novo.vencimento,'2026-10-23T02:59:59.000Z');
  assert.equal(M.limitarUrgencia({...inicial,vencimento:'2026-10-21T02:59:59.000Z'},card,a,NOW).vencimento,'2026-10-21T02:59:59.000Z');
  assert.equal(M.limitarUrgencia(novo,{labels:[]},[],NOW).vencimento,novo.vencimento);
});
test('urgência do protocolo corre desde cadastro, mesmo com etiqueta anterior',()=>{
  const s={inicio:NOW.toISOString(),urgente_em:'2026-10-10T12:00:00Z',vencimento:'2026-11-01T02:59:59Z'};
  assert.equal(M.limitarUrgencia(s,{labels:[{name:'Urgente'}]},[],NOW).vencimento,'2026-10-17T02:59:59.000Z');
});
test('cores e avisos usam dia local, vencimento não antecipa na virada UTC',()=>{
  const s={inicio:NOW.toISOString(),regra:{dias:10,uteis:true},vencimento:'2026-10-23T02:59:59.000Z'};
  assert.equal(M.situacao(s,NOW).cor,'verde');
  assert.equal(M.situacao(s,new Date('2026-10-20T12:00:00Z')).aviso,'vencendo');
  assert.equal(M.situacao(s,new Date('2026-10-23T01:00:00Z')).aviso,'hoje');
  assert.equal(M.situacao(s,new Date('2026-10-23T03:00:00Z')).aviso,'vencido');
});
test('assinatura e pendências continuam correndo; somente conclusão ou arquivo encerram',()=>{
  assert.equal(M.fase('Aguardando Assinatura',false),'assinatura');
  assert.equal(M.fase('PENDÊNCIAS',false),'ativo');
  assert.equal(M.fase('🤖 Gerar Minuta',false),'ativo');
  assert.equal(M.fase('Finalizado',false),'concluido');
  assert.equal(M.fase('Arquivado ✔',false),'arquivado');
});

const { criarServico, CAMPOS } = require('../prazos-atos');
function ambiente({comEstado=true,lista='Gerar Minuta',falharComentario=false,eventos=[]}={}) {
  const gravacoes=[],alertas=new Map();
  let agora=new Date('2026-10-15T12:00:00Z');
  const estado={card_id:cardId,inicio:NOW.toISOString(),evidencia:'entrada',vencimento:'2026-10-17T02:59:59.000Z',regra:{dias:2,uteis:true,ato:'TEST'},urgente_em:null};
  const card={id:cardId,idBoard:M.PROTOCOLO,idList:'bbbbbbbbbbbbbbbbbbbbbbbb',closed:false,due:null,dueComplete:false,labels:[],idMembers:[],customFieldItems:[]};
  const defs=CAMPOS.map((x,i)=>({...x,id:'f'+i,display:{cardFront:true}}));
  const comentarios=[];
  const client={release(){},async query(sql,args=[]) {
    gravacoes.push([sql,args]);
    if(sql.includes('pg_try_advisory'))return {rows:[{ok:true}]};
    if(sql.includes('FROM protocolos'))return {rows:[{numero:1500,dados:{ato:'TEST'},criado_em:NOW}]};
    if(sql.includes('FROM eventos_trello'))return {rows:eventos};
    if(sql.startsWith('SELECT * FROM prazos_atos'))return {rows:comEstado?[structuredClone(estado)]:[]};
    if(sql.startsWith('INSERT INTO prazos_atos_alertas')) { if(!alertas.has(args[0])) alertas.set(args[0],{estado:'pendente'}); }
    if(sql.startsWith('SELECT estado FROM prazos_atos_alertas'))return {rows:[alertas.get(args[0])]};
    if(sql.startsWith('UPDATE prazos_atos_alertas'))alertas.get(args[0]).estado='enviado';
    return {rows:[]};
  }};
  const api=async(method,path,body)=>{
    if(method==='GET'&&path.includes('/actions?'))return path.includes('commentCard')?structuredClone(comentarios):(lista==='Finalizado'?[{id:'c'.repeat(24),date:agora.toISOString(),type:'updateCard',data:{card:{id:cardId},board:{id:card.idBoard},listAfter:{id:card.idList,name:'Finalizado'}}}]:[]);
    if(method==='GET'&&path.includes('/lists?'))return [{id:card.idList,name:lista}];
    if(method==='GET'&&path.endsWith('/customFields'))return defs;
    if(method==='GET'&&path.startsWith('/cards/'))return structuredClone(card);
    if(method==='PUT'&&path.includes('/customField/')) {
      const id=path.split('/customField/')[1].split('/')[0];
      card.customFieldItems=card.customFieldItems.filter(x=>x.idCustomField!==id);
      card.customFieldItems.push({idCustomField:id,value:body.value});return {};
    }
    if(method==='PUT') { Object.assign(card,body);return structuredClone(card); }
    if(method==='POST'&&path.endsWith('/actions/comments')) {
      const a={id:String(comentarios.length+1).padStart(24,'0'),type:'commentCard',date:agora.toISOString(),data:{card:{id:cardId},text:body.text}};
      comentarios.push(a);
      if(falharComentario) { falharComentario=false;throw Error('ACK perdido'); }
      return a;
    }
    throw Error('chamada inesperada '+method+' '+path);
  };
  const s=criarServico({pool:{connect:async()=>client,query:client.query},api,agora:()=>agora,habilitado:()=>true,quadros:async()=>[M.PROTOCOLO]});
  return {s,card,estado,gravacoes,comentarios,alertas,setAgora:d=>agora=new Date(d)};
}
test('relógio global se projeta depois de Gerar Minuta e não repete aviso',async()=>{
  const h=ambiente();
  assert.equal((await h.s.executar({cardIds:[cardId]})).erros,0);
  assert.equal(h.card.due,h.estado.vencimento);
  assert.equal(h.comentarios.length,1);
  assert.equal((await h.s.executar({cardIds:[cardId]})).erros,0);
  assert.equal(h.comentarios.length,1);
});
test('ACK de comentário perdido é recuperado sem enviar duplicado',async()=>{
  const h=ambiente({falharComentario:true});
  assert.equal((await h.s.executar({cardIds:[cardId]})).erros,1);
  assert.equal((await h.s.executar({cardIds:[cardId]})).erros,0);
  assert.equal(h.comentarios.length,1);
});
test('sem passagem comprovada por Cadastro não altera cartão nem inicia prazo',async()=>{
  const h=ambiente({comEstado:false});
  const r=await h.s.executar({cardIds:[cardId]});
  assert.equal(r.estados.aguarda_cadastro,1);assert.equal(h.card.due,null);assert.equal(h.comentarios.length,0);
});
test('transferência de quadro conserva entrada comprovada no histórico do Hub',async()=>{
  const a=action(1,NOW.toISOString(),M.CADASTRO);
  const h=ambiente({comEstado:false,eventos:[{action_id:a.id,tipo:a.type,card_id:cardId,ocorrido_em:a.date,dados:a.data}]});
  const r=await h.s.executar({cardIds:[cardId]});
  assert.equal(r.erros,0);assert.equal(r.estados.ativo,1);
  const insercao=h.gravacoes.find(([sql])=>sql.startsWith('INSERT INTO prazos_atos(card_id'));
  assert.equal(insercao[1][2],NOW.toISOString());assert.equal(insercao[1][3],a.id);
  assert.equal(h.card.due,M.vencimento(NOW.toISOString(),M.regra({ato:'TEST'})));
});
test('histórico preservado divergente não inicia relógio',async()=>{
  const a=action(1,NOW.toISOString(),M.CADASTRO);
  const h=ambiente({comEstado:false,eventos:[{action_id:a.id,tipo:a.type,card_id:'outro',ocorrido_em:a.date,dados:a.data}]});
  const r=await h.s.executar({cardIds:[cardId]});
  assert.equal(r.erros,1);assert.equal(r.ultimo_erro,'historico_divergente');assert.equal(h.card.due,null);
});
test('data da agenda fica preservada na assinatura e relógio canônico continua',async()=>{
  const h=ambiente({lista:'Aguardando Assinatura'});h.card.due='2026-12-01T12:00:00Z';
  assert.equal((await h.s.executar({cardIds:[cardId]})).erros,0);
  assert.equal(h.card.due,'2026-12-01T12:00:00Z');assert.equal(h.card.customFieldItems.length,3);assert.equal(h.comentarios.length,1);
});
test('finalização congela projeção sem avisar atraso',async()=>{
  const h=ambiente({lista:'Finalizado'});
  assert.equal((await h.s.executar({cardIds:[cardId]})).erros,0);assert.equal(h.comentarios.length,0);
  assert.match(h.card.customFieldItems.find(x=>x.idCustomField==='f2').value.text,/Concluído/);
});
test('histórico divergente é rejeitado',async()=>{
  const s=criarServico({api:async()=>[{id:'a'.repeat(24),date:NOW.toISOString(),data:{card:{id:'b'.repeat(24)}}}]});
  await assert.rejects(s.historico(cardId,'updateCard:idList'),/divergente/);
});

test('inventário simples conserva quatro úteis; cumulativo ou complexo usa dez úteis',()=>{
  assert.equal(M.regra({ato:'INV'}).dias,4);
  for(const inventario of [{cumulativo:true},{complexo:true},{cumulativo:true,complexo:true}]){
    const r=M.regra({ato:'INV',inventario});assert.equal(r.dias,10);assert.equal(r.uteis,true);
    assert.equal(M.vencimento('2026-10-02T18:50:11.772Z',r),'2026-10-20T02:59:59.000Z');
  }
  assert.equal(M.regra({ato:'TEST',inventario:{complexo:true}}).dias,5);
});
test('somente caixa marcada reconhece inventário complexo no Trello',()=>{
  assert.deepEqual(M.classificarInventario({},[{checkItems:[{name:'Inventário complexo',state:'complete'}]}]),{complexo:true,cumulativo:false});
  assert.deepEqual(M.classificarInventario({},[{checkItems:[{name:'Inventário complexo',state:'incomplete'}]}]),{complexo:false,cumulativo:false});
});
test('reclassificação complexa conta da mesma entrada e conserva limite urgente',()=>{
  const estado={inicio:'2026-10-02T18:50:11.772Z',vencimento:'2026-10-09T02:59:59.000Z',regra:M.regra({ato:'INV'})};
  const dados={ato:'INV',inventario:{complexo:true}};
  const novo=M.aplicarExcecaoInventario(estado,dados);
  assert.equal(novo.inicio,estado.inicio);assert.equal(novo.vencimento,'2026-10-20T02:59:59.000Z');assert.equal(novo.regra.dias,10);
  const urgente={...estado,urgente_em:estado.inicio,vencimento:'2026-10-07T02:59:59.000Z'};
  assert.equal(M.aplicarExcecaoInventario(urgente,dados).vencimento,urgente.vencimento);
});
