const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {createRouter,allowed}=require('../despesas');
test('Controle de Despesas permite somente César e Jonas, mesmo para outros administradores',async()=>{
  assert(allowed({login:'cesar.bravo'}));assert(allowed({login:'jonas.aragao'}));
  assert(!allowed({login:'outra.pessoa',admin:true}));assert(!allowed(null));
  let initialized=0;
  const app=express();app.use('/hub/despesas',createRouter({session:async token=>token?{login:token}:null,initialize:async()=>{initialized++;},env:{GCP_VISION_KEY:'SEGREDO-FICTICIO'}}));
  const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
  try{
    const base='http://127.0.0.1:'+server.address().port+'/hub/despesas/';
    for(const path of ['data','documents?action=chunk&id=00000000-0000-4000-8000-000000000000&chunk=0','ocr','ocr-config']){
      assert.equal((await fetch(base+path)).status,401,path+' sem sessão');
      assert.equal((await fetch(base+path,{headers:{'X-Auth-Token':'outra.pessoa'}})).status,403,path+' outro usuário');
    }
    assert.equal(initialized,0,'requisições bloqueadas não consultam o acervo');
    for(const login of ['cesar.bravo','jonas.aragao']){
      const response=await fetch(base+'ocr-config',{headers:{'X-Auth-Token':login}});
      assert.equal(response.status,200);const text=await response.text();assert(!text.includes('SEGREDO-FICTICIO'));assert(JSON.parse(text).enabled);
    }
  }finally{await new Promise(resolve=>server.close(resolve));}
});
