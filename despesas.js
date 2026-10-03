// Módulo isolado: reutiliza sessão, PostgreSQL e Vision do Hub CN2O.
// Autorizações são conferidas em TODAS as rotas, inclusive arquivos e OCR.
const express=require('express');
const fs=require('node:fs/promises');
const path=require('node:path');
const native=require('./db');
const allowed=user=>['cesar.bravo','jonas.aragao'].includes(user&&user.login);
let initialization;
async function init(pool=native.pool){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('cn2o-despesas-v1'))");
    const existing=await client.query("SELECT to_regclass('public.despesas_documents') AS name");
    if(!existing.rows[0].name)await client.query(await fs.readFile(path.join(__dirname,'despesas/schema.sql'),'utf8'));
    await client.query(await fs.readFile(path.join(__dirname,'despesas/google-schema.sql'),'utf8'));
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
}
function ready(){return initialization??=(init().catch(error=>{initialization=null;throw error;}));}
function createRouter({session=native.sessaoValida,pool=native.pool,initialize=ready,env=process.env,fetcher=fetch}={}){
  const router=express.Router();
  const google=require('./despesas/google-sync').createGoogleSync({pool,initialize,fetcher});
  router.get('/google/callback',async(req,res)=>{
    res.set('Cache-Control','no-store');
    try{await google.finish(req.query);res.type('html').send('<!doctype html><meta charset="utf-8"><title>CN2O · Google conectado</title><h1>Google conectado</h1><p>A sincronização foi iniciada. Você pode voltar ao Controle de Despesas.</p><a href="https://cn2o-hub.netlify.app/#despesas">Voltar ao Hub CN2O</a>');}
    catch(error){res.status(400).type('text').send(error.publicMessage||'Não foi possível concluir a conexão Google. Volte ao Hub e tente novamente.');}
  });
  router.use(async(req,res,next)=>{
    res.set('Cache-Control','private, no-store');
    try{
      const user=await session(req.get('X-Auth-Token'));
      if(!user)return res.status(401).json({error:'Entre no Hub CN2O para acessar o Controle de Despesas.'});
      if(!allowed(user))return res.status(403).json({error:'Acesso exclusivo de César Bravo e Jonas Aragão.'});
      req.expenseUser={...user,id:user.login,name:user.nome||user.login};next();
    }catch{return res.status(503).json({error:'Não foi possível confirmar a sessão.'});}
  });
  router.use(express.json({limit:'4mb'}));
  router.use(express.raw({type:'application/octet-stream',limit:1024*1024+1024}));
  router.get('/google/status',async(req,res)=>{try{res.json(await google.status());google.poke();}catch{res.status(503).json({error:'Não foi possível consultar a sincronização Google.'});}});
  router.post('/google/config',async(req,res)=>{
    if(req.expenseUser.login!=='cesar.bravo')return res.status(403).json({error:'Somente César Bravo pode configurar a conta Google.'});
    try{res.json(await google.configure(req.body));}catch(error){res.status(400).json({error:error.publicMessage||'Não foi possível configurar o Google.'});}
  });
  router.post('/google/connect',async(req,res)=>{
    if(req.expenseUser.login!=='cesar.bravo')return res.status(403).json({error:'Somente César Bravo pode conectar a conta Google.'});
    try{res.json(await google.connect());}catch(error){res.status(400).json({error:error.publicMessage||'Não foi possível iniciar a conexão Google.'});}
  });
  router.post('/google/sync',async(req,res)=>{try{await initialize();await google.enqueueAll();google.poke();res.json({queued:true});}catch{res.status(503).json({error:'Não foi possível solicitar a sincronização.'});}});
  router.get('/ocr-config',async(req,res)=>{
    const {settings}=await import('./despesas/ocr-config.mjs');res.json(settings(env));
  });
  for(const route of ['data','documents','ocr'])router.all('/'+route,async(req,res)=>{
    try{
      await initialize();
      const {adapter,originalStore}=await import('./despesas/database.mjs');
      const db=adapter(pool),user=req.expenseUser;
      const authenticate=async()=>user;
      let method=req.method;
      if(route==='documents'&&req.query.action==='chunk'&&method==='POST')method='PUT';
      const headers=new Headers();
      if(req.get('Content-Type'))headers.set('Content-Type',req.get('Content-Type'));
      const body=['GET','HEAD'].includes(method)?undefined:Buffer.isBuffer(req.body)?req.body:JSON.stringify(req.body??{});
      if(body)headers.set('Content-Length',String(Buffer.byteLength(body)));
      const request=new Request('https://hub.internal'+req.url,{method,headers,body});
      const {processRequest}=await import('./despesas/'+route+'.mjs');
      const deps={db,authenticate,store:originalStore(pool),env,fetcher};
      if(route==='ocr')deps.reservePage=async limit=>{
        const rows=await db.sql`INSERT INTO despesas_ocr_usage(month,count) VALUES(date_trunc('month',now())::date,1)
          ON CONFLICT(month) DO UPDATE SET count=despesas_ocr_usage.count+1 WHERE despesas_ocr_usage.count<${limit} RETURNING count`;
        return rows.length>0;
      };
      const response=await processRequest(request,deps);
      res.status(response.status);
      for(const [key,value] of response.headers)res.set(key,value);
      res.send(Buffer.from(await response.arrayBuffer()));
      if(response.ok&&req.method==='POST'&&(route==='data'||route==='documents'&&['finish','ocr'].includes(req.query.action)))google.poke();
    }catch{res.status(503).json({error:'Controle de Despesas indisponível. O salvamento não foi confirmado.'});}
  });
  // Continuous copying also resumes after a process restart, without an open browser.
  if(pool===native.pool&&initialize===ready)google.poke();
  return router;
}
module.exports={router:createRouter(),createRouter,allowed,init};
