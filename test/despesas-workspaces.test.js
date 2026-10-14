'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash,randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
process.env.DATABASE_URL='postgres://test:test@127.0.0.1:1/isolated_test';
const {init,createRouter}=require('../despesas');
const {scopedPool,profile}=require('../despesas/workspaces');
const {transfer,audit,evidence}=require('../despesas/routing');
const user={id:'cesar.bravo',login:'cesar.bravo',name:'Teste'};
function pgPool(db){
  const query=async(text,values)=>{
    if(typeof text==='object'){values=text.values;text=text.text;}
    if(!values?.length&&(text.includes(';')||/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/.test(text))){const out=await db.exec(text);return out.at(-1)||{rows:[]};}
    return db.query(text,values);
  };
  return {query,connect:async()=>({query,release(){}})};
}
async function fixture(t){
  const pg=new PGlite(),pool=pgPool(pg);await init(pool);await init(scopedPool(pool,'bravo'));
  t.after(()=>pg.close());
  const {adapter,originalStore}=await import('../despesas/database.mjs');
  const request=async(workspace,route,url,body)=>{
    const p=scopedPool(pool,workspace),{processRequest}=await import('../despesas/'+route+'.mjs');
    const r=await processRequest(new Request('https://test/'+route+url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),{workspace,authenticate:async()=>user,db:adapter(p),store:originalStore(p)});
    return {status:r.status,body:await r.json()};
  };
  async function document(workspace='cn2o',name='BRAVO_PATRIMONIAL_ficticio.pdf'){
    const id=randomUUID(),bytes=Buffer.from('%PDF-1.7\noriginal ficticio '+id),hash=createHash('sha256').update(bytes).digest('hex');
    const p=scopedPool(pool,workspace),metadata={name,kind:'Nota fiscal ou recibo',period:'2026-10',size:bytes.length,type:'application/pdf'};
    await p.query("INSERT INTO despesas_documents(id,hash,metadata,state,created_by) VALUES($1,$2,$3::jsonb,'complete','cesar.bravo')",[id,hash,JSON.stringify(metadata)]);
    await p.query('INSERT INTO despesas_parts(document_id,part,digest,bytes) VALUES($1,0,$2,$3)',[id,hash,bytes]);
    return {id,hash,bytes,metadata,version:1};
  }
  return {pool,request,document};
}
function entry(doc){return {id:randomUUID(),supplier:'Fornecedor fictício',description:'Despesa da empresa fictícia',taxId:'',cents:12345,paidDate:'2026-10-01',referencePeriod:'2026-10',category:'software',treatment:'analise',reason:'Conferir',notes:'Teste',docIds:[doc.id],paymentConfirmed:true,docsConfirmed:false,reviewed:false};}

test('namespaces reject arbitrary table names and do not rewrite bound data',async t=>{
  assert.throws(()=>profile('bravo;DROP TABLE despesas_entries'));
  const calls=[],p=scopedPool({query:async(...args)=>{calls.push(args);return {rows:[]};}},'bravo');
  await p.query('SELECT * FROM despesas_documents WHERE metadata=$1',['despesas_documents is a document name']);
  assert.equal(calls[0][0],'SELECT * FROM bravo_despesas_documents WHERE metadata=$1');
  assert.equal(calls[0][1][0],'despesas_documents is a document name');
});
test('actual PostgreSQL schemas isolate documents, originals, entry links and caller-supplied workspace',async t=>{
  const f=await fixture(t),doc=await f.document();
  assert.equal((await f.request('cn2o','data','')).body.documents.length,1);
  assert.equal((await f.request('bravo','data','')).body.documents.length,0);
  assert.equal((await f.request('bravo','documents','?action=chunk&id='+doc.id+'&chunk=0')).status,404);
  assert.equal((await f.request('bravo','data','',{...entry(doc),workspace:'cn2o'})).status,400);
  const own=await f.document('bravo'),result=await f.request('bravo','data','',{...entry(own),workspace:'cn2o'});
  assert.equal(result.status,200);
  const state=(await f.request('bravo','data','')).body;assert.equal(state.workspace,'bravo');assert.equal(state.entries[0].workspace,'bravo');
  assert.equal((await f.request('cn2o','data','')).body.entries.length,0);
});
test('document transfer is transactional, verified by SHA-256, idempotent and reversible',async t=>{
  const f=await fixture(t),doc=await f.document();
  const args={pool:f.pool,source:'cn2o',target:'bravo',actor:'cesar.bravo',input:{kind:'document',id:doc.id,version:1,reason:'Tomador Bravo confirmado no original fictício'}};
  assert.equal((await transfer(args)).documentId,doc.id);
  assert.equal((await transfer(args)).reused,true);
  assert.equal((await f.request('cn2o','data','')).body.documents.length,0);
  const state=(await f.request('bravo','data','')).body;assert.equal(state.documents[0].hash,doc.hash);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM despesas_parts')).rows[0].n,1,'source original retained for audit');
  assert.equal((await f.request('cn2o','documents','?action=chunk&id='+doc.id+'&chunk=0')).status,404);
  await transfer({pool:f.pool,source:'bravo',target:'cn2o',actor:'cesar.bravo',input:{kind:'document',id:doc.id,version:1,reason:'Correção de destinação fictícia para testar reversão'}});
  assert.equal((await f.request('cn2o','data','')).body.documents.length,1);
  assert.equal((await f.request('bravo','data','')).body.documents.length,0);
});
test('corruption and version conflicts roll back without hiding the source',async t=>{
  const f=await fixture(t),doc=await f.document();
  const args={pool:f.pool,source:'cn2o',target:'bravo',actor:'cesar.bravo',input:{kind:'document',id:doc.id,version:2,reason:'Tomador Bravo fictício'}};
  await assert.rejects(transfer(args),e=>e.status===409);
  await f.pool.query('UPDATE despesas_parts SET bytes=$2 WHERE document_id=$1',[doc.id,Buffer.from('corrupt')]);
  args.input.version=1;await assert.rejects(transfer(args),e=>e.status===409);
  assert.equal((await f.request('cn2o','data','')).body.documents.length,1);
  assert.equal((await f.request('bravo','data','')).body.documents.length,0);
});
test('linked document cannot move alone; complete entry moves once and resets accounting approval',async t=>{
  const f=await fixture(t),doc=await f.document(),e={...entry(doc),treatment:'dedutivel',docsConfirmed:true,reviewed:true};
  assert.equal((await f.request('cn2o','data','',e)).status,200);
  const args={pool:f.pool,source:'cn2o',target:'bravo',actor:'cesar.bravo',input:{kind:'document',id:doc.id,version:1,reason:'Tomador Bravo fictício'}};
  await assert.rejects(transfer(args),error=>error.status===409);
  args.input={...args.input,kind:'entry',id:e.id};await transfer(args);
  const before=(await f.request('cn2o','data','')).body,after=(await f.request('bravo','data','')).body;
  assert.equal(before.entries.filter(x=>!x.voided).length,0);assert.equal(before.entries[0].history.length,2);
  assert.equal(after.entries.length,1);assert.equal(after.entries[0].cents,e.cents);
  assert.equal(after.entries[0].reviewed,false);assert.equal(after.entries[0].docsConfirmed,false);
  assert.equal(after.entries[0].paymentConfirmed,true);assert.equal(after.entries[0].docIds[0],doc.id);
  assert.equal((await transfer(args)).reused,true);
  assert.equal((await f.request('cn2o','data','',{...e,version:2})).status,400);
  await transfer({pool:f.pool,source:'bravo',target:'cn2o',actor:'cesar.bravo',input:{kind:'entry',id:e.id,version:1,reason:'Reversão fictícia mantendo toda a auditoria'}});
  const restored=(await f.request('cn2o','data','')).body;assert.equal(restored.entries[0].voided,false);
  assert.equal(restored.entries[0].history.length,3);assert.equal(restored.documents.length,1);
});
test('full-acervo audit distinguishes company signals from the users surname',async t=>{
  const f=await fixture(t);await f.document();await f.document('cn2o','Recibo-Cesar-Bravo.pdf');
  const result=await audit({pool:f.pool,workspace:'cn2o'});assert.equal(result.documentCount,2);
  assert.equal(result.documents.filter(d=>d.signals.length).length,1);
  assert.deepEqual(evidence({metadata:{name:'César Bravo'},ocr:{pages:[{text:'Tomador César Bravo'}]}}),[]);
});
test('Bravo HTTP endpoints keep the existing authorization boundary',async t=>{
  const express=require('express'),f=await fixture(t),app=express();
  const router=createRouter({pool:f.pool,workspace:'bravo',initialize:async()=>{},session:async token=>token==='owner'?user:token==='jonas'?{login:'jonas.aragao'}:token==='employee'?{login:'outro'}:null});
  app.use('/hub/despesas-bravo',router);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>server.close());const url='http://127.0.0.1:'+server.address().port+'/hub/despesas-bravo/data';
  assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{'X-Auth-Token':'employee'}})).status,403);
  const response=await fetch(url,{headers:{'X-Auth-Token':'owner'}});assert.equal(response.status,200);assert.equal((await response.json()).workspace,'bravo');
  assert.equal((await fetch(url,{headers:{'X-Auth-Token':'jonas'}})).status,200);
  assert.equal((await fetch(url.replace('/data','/routing'),{method:'POST',headers:{'X-Auth-Token':'jonas','Content-Type':'application/json'},body:'{}'})).status,403);
});
