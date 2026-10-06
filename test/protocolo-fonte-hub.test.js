'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const f=require('../protocolo-fonte'),ia=require('../protocolo-fonte-ia');
const fixture=require('./fixtures/protocolo-fonte-v1.json');
function ambiente(){
  const fonte=JSON.parse(JSON.stringify(fixture.fonte)),routes=new Map(),calls=[],sqls=[],geracoes=[];
  let stale=false,staleDurante=false,semProtocolo=false;
  const router={use(){},get(p,...h){routes.set('GET '+p,h.at(-1));},post(p,...h){routes.set('POST '+p,h.at(-1));}};
  const query=async(sql,params)=>{sqls.push({sql,params});return{rows:[]};};
  const source={
    obter:async()=>fonte,
    doPedido:async b=>{if(b.protocolo_ausente){semProtocolo=true;return null;}f.validarRevisao(fonte,b.protocolo_revisao);return fonte;},
    conferir:async()=>{if(stale)throw f.falha(409,'FONTE_DESATUALIZADA','Fonte mudou.');},
    comFonteAtual:async(_f,_u,cb)=>{await source.conferir();return cb({query});},
    registrarGeracao:async g=>{geracoes.push(g);return '11111111-1111-4111-8111-111111111111';},
    obterGeracao:async(id,u)=>{
      if(id!=='11111111-1111-4111-8111-111111111111'||u.login!=='teste.escrevente')throw f.falha(404,'GERACAO_NAO_ENCONTRADA','Geração não encontrada');
      return{id,fonte_snapshot:fonte,texto_sha256:f.hash('Minuta salva')};
    }
  };
  const gemini={MODELO_UNICO:'falso',executar:async args=>{calls.push(args);if(staleDurante)stale=true;
    const texto='Estado: PRONTA\n===MINUTA_COPIAVEL===\nEscritura fictícia.\n===FIM_MINUTA===';
    return{texto:semProtocolo?texto:JSON.stringify({texto,decisoes:[]}),uso:{modelo:'falso',custo_usd:0}};
  }};
  const deps={express:{Router:()=>router,json:()=>()=>{}},'./db':{pool:{query}},'./gemini':gemini,'./hub-prompts':{minuta:{prompt:'Prompt fictício'}},
    './protocolo-fonte':f,'./protocolo-fonte-db':source,'./protocolo-fonte-ia':ia,'./trello':{},'./ocr':{ativo:()=>false},'./docs':{ativo:()=>false},
    './auth':{},'./limite-ia':{aguardarLimite:()=>0,tetoDiario:async()=>({excedido:false})},'./ia-defesa':require('../ia-defesa'),
    './atos':{NOMES_ATO:{}},'./acervo':{},'./db-agentes':{registrarConsumo:async()=>{}},'./protecao':{mascaraIp:()=>''}};
  const sandbox={module:{exports:{}},process:{env:{GEMINI_API_KEY:'chave-falsa-sem-rede',HUB_ADMINS:'teste.escrevente'}},console:{error(){},log(){}},Buffer,setTimeout,clearTimeout,
    require:n=>{if(n==='crypto')return require('crypto');if(Object.hasOwn(deps,n))return deps[n];throw Error('Dependência inesperada '+n);}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','hub.js'),'utf8'),sandbox);
  return{fonte,calls,geracoes,sqls,setDurante(){staleDurante=true;},async call(rota,body,usuario={login:'teste.escrevente',nome:'Equipe teste'}){
    const res={statusCode:200,status(n){this.statusCode=n;return this;},set(){},json(v){this.body=v;return this;}};
    await routes.get(rota)({body,usuario,params:{ferramenta:'minuta',numero:999001},headers:{},get(){return'';},ip:'127.0.0.1'},res);return res;
  }};
}
const pedido=e=>({texto:'Entrevista fictícia',protocolo:999001,protocolo_revisao:e.fonte.revisao.sha256,fonte_protocolo:{dados:{preco:'forjado'}}});
test('Hub envia a fonte real e devolve conferência separada, snapshot e PRELIMINAR',async()=>{
  const e=ambiente(),r=await e.call('POST /ia/:ferramenta',pedido(e));
  assert.equal(r.statusCode,200);assert.match(e.calls[0].observacoes,/100.000,00/);assert.ok(!e.calls[0].observacoes.includes('forjado'));
  assert.match(r.body.texto,/Estado: PRELIMINAR/);assert.equal(r.body.fonte_status,'requer_conferencia');assert.equal(e.geracoes.length,1);
  assert.equal(e.geracoes[0].fonte,e.fonte);assert.equal(r.body.fonte_geracao_id,'11111111-1111-4111-8111-111111111111');
});
test('Hub recusa revisão inválida antes da chamada IA',async()=>{
  const e=ambiente(),r=await e.call('POST /ia/:ferramenta',{...pedido(e),protocolo_revisao:'0'.repeat(64)});
  assert.equal(r.statusCode,409);assert.equal(e.calls.length,0);
});
test('Hub descarta resultado se fonte mudar enquanto a IA trabalha',async()=>{
  const e=ambiente();e.setDurante();const r=await e.call('POST /ia/:ferramenta',pedido(e));
  assert.equal(r.statusCode,409);assert.equal(e.geracoes.length,0);
});
test('Hub distingue ausência expressa de protocolo de fonte importada',async()=>{
  const e=ambiente(),r=await e.call('POST /ia/:ferramenta',{texto:'Entrevista fictícia',protocolo_ausente:true});
  assert.equal(r.statusCode,200);assert.equal(r.body.fonte_status,'sem_protocolo');assert.equal(e.geracoes[0].fonte,null);
});
test('salvar minuta vincula geração privada pelo id e invalida cobertura após edição',async()=>{
  const e=ambiente(),r=await e.call('POST /minutas',{texto:'Edição humana',fonte_geracao_id:'11111111-1111-4111-8111-111111111111',fonte_snapshot:{fake:true}});
  assert.equal(r.statusCode,200);
  const insert=e.sqls.find(x=>x.sql.startsWith('INSERT INTO hub_minutas'));
  assert.equal(insert.params[5],'11111111-1111-4111-8111-111111111111');assert.equal(insert.params[6],'texto_editado_requer_conferencia');
});
test('geração de outro usuário não pode ser vinculada no salvamento',async()=>{
  const e=ambiente(),r=await e.call('POST /minutas',{texto:'Edição',fonte_geracao_id:'99999999-9999-4999-8999-999999999999'});
  assert.equal(r.statusCode,404);assert.ok(!e.sqls.some(x=>x.sql.startsWith('INSERT INTO hub_minutas')));
});
