'use strict';
// Todos os nomes, logins, IDs e protocolos deste arquivo são fictícios.
const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../prazos-atos-modelo'),P=require('../prazos-atos-painel');
const {criarCalendario}=require('../horas-uteis');
test('avisos distintos em D-2, D-1 e D0, pulando fins de semana',()=>{
  const prazo='2026-10-20T02:59:59.000Z'; // segunda 19, às 23h59 local
  assert.deepEqual(M.marcos(prazo).map(m=>[m.tipo,m.dia]),[['dois_dias','2026-10-15'],['vespera','2026-10-16'],['hoje','2026-10-19']]);
  assert.equal(M.avisoDoDia(prazo,new Date('2026-10-15T12:00:00Z')),'dois_dias');
  assert.equal(M.avisoDoDia(prazo,new Date('2026-10-16T12:00:00Z')),'vespera');
  assert.equal(M.avisoDoDia(prazo,new Date('2026-10-17T12:00:00Z')),null);
  assert.equal(M.avisoDoDia(prazo,new Date('2026-10-20T02:00:00Z')),'hoje');
  assert.equal(M.avisoDoDia(prazo,new Date('2026-10-20T03:00:00Z')),'vencido');
});
test('pré-avisos respeitam feriados operacionais inclusive quando o prazo é corrido',()=>{
  const c=criarCalendario({feriadosExtra:'2026-10-16'});
  assert.deepEqual(M.marcos('2026-10-19T02:59:59Z',c).map(m=>m.dia),['2026-10-14','2026-10-15','2026-10-18']);
});
const usuarios=[{login:'test.writer_a',nome:'FICTITIOUS WRITER A'},{login:'test.writer_b',nome:'FICTITIOUS WRITER B'}];
const escreventes=[{login:'test.writer_a',nome:'FICTITIOUS WRITER A',board_id:'fictional_board_a',ativo:true},{login:'test.legacy_b',nome:'FICTITIOUS WRITER B',board_id:'fictional_board_b',ativo:true}];
test('responsável acompanha o quadro da escrevente e persiste ao ir ao tabelião',()=>{
  assert.equal(P.resolverResponsavel('fictional_board_a','Revisar Minuta',usuarios,escreventes),'test.writer_a');
  assert.equal(P.resolverResponsavel('fictional_board_b','Revisar Minuta',usuarios,escreventes,'test.writer_a'),'test.writer_b');
  assert.equal(P.resolverResponsavel('tabeliao','Conferir Minuta',usuarios,escreventes,'test.writer_a'),'test.writer_a');
  assert.equal(P.resolverResponsavel('protocolo','Cadastro Extradigital',usuarios,escreventes),null);
});
test('nomes ambíguos e aproximações não expõem prazos à pessoa errada',()=>{
  assert.equal(P.resolverResponsavel('fictional_board_a','Minuta',[...usuarios,{login:'test.duplicate_a',nome:'FICTITIOUS WRITER A'}],escreventes),null);
  assert.equal(P.resolverResponsavel('cert','ESCREVENTE FICTITIOUS WRITER A EXTRA',usuarios,escreventes),null);
  assert.equal(P.resolverResponsavel('cert','ESCREVENTE FICTITIOUS WRITER A',usuarios,escreventes),'test.writer_a');
});
test('consulta pessoal usa o login da sessão, sem aceitar filtro de cliente',async()=>{
  let consulta;
  const f=P.criarConsulta({pool:{query:async(sql,args)=>{if(sql.includes('FROM prazos_atos WHERE'))consulta={sql,args};return {rows:[]};}}});
  await f({login:'test.writer_a'},false);
  assert.deepEqual(consulta.args,['test.writer_a',false]);
  assert.match(consulta.sql,/responsavel_login=\$1/);
  assert.match(consulta.sql,/estado IN \('ativo','assinatura'\)/);
  await assert.rejects(f(null),/sessao_obrigatoria/);
});
test('visão administrativa e resumo não retornam dados de dossiê',async()=>{
  const row={card_id:'a'.repeat(24),protocolo:1500,inicio:'2026-10-14T12:00:00Z',vencimento:'2026-10-29T02:59:59Z',regra:{ato:'CV-Urbano',dias:10,uteis:true},responsavel_login:'test.writer_a',card_url:'https://trello.com/c/ABC123',confirmado_em:'2026-10-26T12:00:00Z'};
  let args;
  const f=P.criarConsulta({agora:()=>new Date('2026-10-26T12:00:00Z'),pool:{query:async(_sql,a)=>{if(_sql.includes('FROM prazos_atos WHERE')){args=a;return {rows:[row]};}return {rows:[]};}}});
  const r=await f({login:'test.admin'},true);
  assert.equal(args[1],true);assert.equal(r.escopo,'equipe');assert.equal(r.resumo.dois_dias,1);
  assert.equal(r.itens[0].marcos.length,3);assert.equal('dados' in r.itens[0],false);
  assert.equal(r.itens[0].trello_url,row.card_url);
});


test('agenda e painel setorial usam o mesmo início e marcos de 6h, 7h e 8h',()=>{
  const row={card_id:'x',protocolo:1500,detalhes:{inicio:'2026-10-14T12:00:00Z',marco_inicial:'digitalizacao'}};
  const i=P.setorItem(row,new Date('2026-10-14T19:00:00Z'));
  assert.equal(i.aviso,'duas_horas');assert.equal(i.cor,'amarelo');
  assert.deepEqual(i.marcos.map(m=>m.hora),['16:00','17:00','09:00']);
  assert.equal(i.marcos[2].dia,'2026-10-15');
  assert.equal(P.setorItem({...row,detalhes:{inicio:row.detalhes.inicio}}),null);
  assert.equal(P.setorItem({...row,detalhes:{inicio:row.detalhes.inicio,marco_inicial:'cadastro_extradigital'}}),null);
});
