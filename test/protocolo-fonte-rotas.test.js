'use strict';
// Executa handlers reais dos agentes sem abrir porta, banco, Trello, OCR ou LLM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const f = require('../protocolo-fonte');
const fonteIA = require('../protocolo-fonte-ia');
const fixture = require('./fixtures/protocolo-fonte-v1.json');
const clone = v => JSON.parse(JSON.stringify(v));
function ambiente() {
  const routes = new Map(), fonte = clone(fixture.fonte), chamadas = [];
  let stale = false, staleDurante = false, minuta = null, salvos = 0;
  const router = { use(){}, get(p,...h){ routes.set('GET '+p,h.at(-1)); },post(p,...h){routes.set('POST '+p,h.at(-1));} };
  const resposta = () => ({statusCode:200,set(){},status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}});
  const dba = {
    obterAgente:async()=>({slug:'cv',nome:'Compra e venda',ativo:true,codigo_ato:'CV-Urbano',campos:[]}),
    criarMinuta:async dados=>{salvos++;minuta={id:1,...dados};return minuta;},
    obterMinuta:async()=>minuta,
    atualizarMinuta:async(_id,dados)=>{salvos++;minuta={...minuta,...dados};return minuta;},
    registrarConsumo:async()=>{},registrarTurno:async()=>{}
  };
  const source = {
    doPedido:async b=>{if(b.protocolo_ausente)return null;f.validarRevisao(fonte,b.protocolo_revisao);return fonte;},
    conferir:async()=>{if(stale)throw f.falha(409,'FONTE_DESATUALIZADA','Fonte mudou');},
    comFonteAtual:async(_f,_u,trabalho)=>{await source.conferir();return trabalho({});},
    situacao:async()=>({fonte_desatualizada:stale}),obter:async()=>fonte
  };
  const uso={modelo:'modelo-falso',tokens_entrada:1,tokens_saida:1,custo_usd:0};
  const gemini = {
    extrair:async args=>{chamadas.push(args);if(staleDurante)stale=true;return{dados:{preco:'100.000,00',_alertas:[],_fonte_decisoes:[]},uso};},
    redigir:async args=>{chamadas.push(args);if(staleDurante)stale=true;return{texto:JSON.stringify({texto:'Minuta fictícia.',decisoes:[]}),uso};},
    revisar:async args=>{chamadas.push(args);if(staleDurante)stale=true;return{texto:JSON.stringify({texto:'Minuta revisada fictícia.',decisoes:[]}),uso};}
  };
  const sandbox={module:{exports:{}},console:{error(){}},process:{env:{}},Buffer,require:n=>{
    if(n==='express')return{Router:()=>router,json:()=>()=>{}};
    if(n==='./db-agentes')return dba;if(n==='./db')return{pool:{}};if(n==='./gemini')return gemini;
    if(n==='./protocolo-fonte')return f;if(n==='./protocolo-fonte-db')return source;if(n==='./protocolo-fonte-ia')return fonteIA;
    if(n==='./ocr')return{ativo:()=>false};if(n==='./limite-ia')return{};if(n==='./docx')return{};
    throw new Error('Dependência imprevista '+n);
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','agentes.js'),'utf8'),sandbox);
  return { fonte,chamadas,get minuta(){return minuta;},get salvos(){return salvos;},setStale(v){stale=v;},setDurante(v){staleDurante=v;},
    async call(route,body={},usuario={login:'teste.escrevente',cargo:'Escrevente'}){const res=resposta();await routes.get(route)({params:{slug:'cv',id:'1'},body,usuario},res);return res;}
  };
}
const pedido = e => ({protocolo:999001,protocolo_revisao:e.fonte.revisao.sha256,observacoes:'Caso fictício',fonte_protocolo:{dados:{preco:'FORJADO'}}});
test('extração usa a fonte do servidor, não envelope do cliente; snapshot fica separado',async()=>{
  const e=ambiente();const res=await e.call('POST /:slug/extrair',pedido(e));
  assert.equal(res.statusCode,200);assert.equal(e.chamadas[0].fonte,e.fonte);assert.equal(e.minuta.fonte_snapshot,e.fonte);
  assert.equal(e.minuta.dados._fonte_decisoes,undefined);assert.equal(e.minuta.fonte_conferencia.length,e.fonte.campos.length);
});
test('mudança durante extração descarta resultado e não grava minuta',async()=>{
  const e=ambiente();e.setDurante(true);const res=await e.call('POST /:slug/extrair',pedido(e));
  assert.equal(res.statusCode,409);assert.equal(e.salvos,0);
});
test('redação e revisão recebem snapshot e matriz guardados, não cliente',async()=>{
  const e=ambiente();await e.call('POST /:slug/extrair',pedido(e));
  let res=await e.call('POST /minutas/:id/redigir',{dados:{preco:'editor'},fonte_snapshot:{fake:true}});
  assert.equal(res.statusCode,200);assert.equal(e.chamadas[1].fonte,e.fonte);assert.equal(e.minuta.texto,'Minuta fictícia.');
  res=await e.call('POST /minutas/:id/revisar',{pedido:'Ajuste fictício',fonte_snapshot:{fake:true}});
  assert.equal(res.statusCode,200);assert.equal(e.chamadas[2].fonte,e.fonte);assert.equal(res.body.conferencia_fonte.length,e.fonte.campos.length);
});
test('fonte obsoleta antes da redação impede chamada à IA',async()=>{
  const e=ambiente();await e.call('POST /:slug/extrair',pedido(e));e.setStale(true);
  const res=await e.call('POST /minutas/:id/redigir',{});
  assert.equal(res.statusCode,409);assert.equal(e.chamadas.length,1);
});
test('fonte muda durante redação: não sobrescreve snapshot/texto',async()=>{
  const e=ambiente();await e.call('POST /:slug/extrair',pedido(e));e.setDurante(true);
  const res=await e.call('POST /minutas/:id/redigir',{});
  assert.equal(res.statusCode,409);assert.equal(e.salvos,1);assert.equal(e.minuta.texto,undefined);
});
test('fonte muda durante revisão: preserva minuta anterior',async()=>{
  const e=ambiente();await e.call('POST /:slug/extrair',pedido(e));await e.call('POST /minutas/:id/redigir',{});e.setDurante(true);
  const res=await e.call('POST /minutas/:id/revisar',{pedido:'Ajuste'});
  assert.equal(res.statusCode,409);assert.equal(e.minuta.texto,'Minuta fictícia.');
});
test('minuta de outra escrevente não é reaberta nem redigida',async()=>{
  const e=ambiente();await e.call('POST /:slug/extrair',pedido(e));
  assert.equal((await e.call('POST /minutas/:id/redigir',{}, {login:'outra',cargo:'Escrevente'})).statusCode,403);
});
test('cliente não troca vínculo da fonte via salvar',async()=>{
  const e=ambiente();await e.call('POST /:slug/extrair',pedido(e));
  assert.equal((await e.call('POST /minutas/:id/salvar',{protocolo:999002})).statusCode,409);
});
test('edição manual invalida cobertura sem apagar fonte original',async()=>{
  const e=ambiente();await e.call('POST /:slug/extrair',pedido(e));await e.call('POST /minutas/:id/redigir',{});
  assert.equal((await e.call('POST /minutas/:id/salvar',{texto:'Correção humana'})).statusCode,200);
  assert.equal(e.minuta.fonte_snapshot,e.fonte);assert.ok(e.minuta.fonte_conferencia.every(c=>c.cobertura==='pendente'));
});
