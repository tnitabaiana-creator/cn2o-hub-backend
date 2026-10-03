'use strict';
const {randomBytes,createHash}=require('node:crypto');
const {Buffer}=require('node:buffer');
const EXPECTED='tnitabaiana@gmail.com';
const CALLBACK='https://cn2o-hub-backend-production.up.railway.app/hub/despesas/google/callback';
const DRIVE='https://www.googleapis.com/drive/v3';
const SHEETS='https://sheets.googleapis.com/v4/spreadsheets';
const hash=s=>createHash('sha256').update(s).digest('hex');
const apiError=message=>Object.assign(new Error(message),{publicMessage:message});
const escapeQuery=s=>String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
function createGoogleSync({pool,initialize,fetcher=fetch,callback=CALLBACK}={}){
 let busy=false,access=null,timer;
 async function connection(){return (await pool.query('SELECT * FROM despesas_google_connection WHERE id=1')).rows[0];}
 async function jsonRequest(url,options){const response=await fetcher(url,{...options,signal:AbortSignal.timeout(45000)});let body;try{body=await response.json();}catch{throw apiError('Google não retornou uma resposta válida. Tente sincronizar novamente.');}if(!response.ok)throw apiError(response.status===401?'A autorização do Google expirou. Reconecte a conta.':response.status===403?'Google recusou o acesso. Confira as APIs Drive e Sheets e as permissões da conta.':response.status===429?'Limite temporário do Google. A sincronização será repetida.':'Google não confirmou a sincronização (HTTP '+response.status+').');return body;}
 async function token(c){if(access&&access.until>Date.now()+60000)return access.value;const d=c.credentials;if(!d.refresh_token)throw apiError('Conecte a conta Google para iniciar a sincronização.');const t=await jsonRequest('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:d.refresh_token,client_id:d.client_id,client_secret:d.client_secret})});access={value:t.access_token,until:Date.now()+Number(t.expires_in||3600)*1000};return access.value;}
 async function api(c,url,options={}){const bearer=await token(c);try{return await jsonRequest(url,{...options,headers:{Authorization:'Bearer '+bearer,...options.headers}});}catch(e){access=null;throw e;}}
 const post=(c,url,body)=>api(c,url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 async function findFile(c,q){const data=await api(c,DRIVE+'/files?'+new URLSearchParams({q:q+' and trashed=false',fields:'files(id,webViewLink,parents)',pageSize:'100'}));return data.files?.[0];}
 async function folder(c,name,parent,key){let f=await findFile(c,"mimeType='application/vnd.google-apps.folder' and appProperties has { key='cn2oKey' and value='"+escapeQuery(key)+"' }"+(parent?" and '"+escapeQuery(parent)+"' in parents":""));if(!f)f=await post(c,DRIVE+'/files?fields=id,webViewLink',{name,mimeType:'application/vnd.google-apps.folder',...(parent?{parents:[parent]}:{}),appProperties:{cn2oKey:key}});if(!f.id||!f.webViewLink)throw apiError('Google não confirmou a pasta criada.');return f;}
 async function resources(c){
  const root=await folder(c,'CN2O — Controle de Despesas',null,'controle-despesas-root');
  let sheet=await findFile(c,"mimeType='application/vnd.google-apps.spreadsheet' and '"+escapeQuery(root.id)+"' in parents and appProperties has { key='cn2oKey' and value='controle-despesas-sheet' }");
  if(!sheet)sheet=await post(c,DRIVE+'/files?fields=id,webViewLink',{name:'Controle de Despesas — CN2O',mimeType:'application/vnd.google-apps.spreadsheet',parents:[root.id],appProperties:{cn2oKey:'controle-despesas-sheet'}});
  if(!sheet.id||!sheet.webViewLink)throw apiError('Google não confirmou a planilha criada.');
  await pool.query('UPDATE despesas_google_connection SET folder_id=$1,folder_url=$2,spreadsheet_id=$3,spreadsheet_url=$4 WHERE id=1',[root.id,root.webViewLink,sheet.id,sheet.webViewLink]);
  return {...c,folder_id:root.id,folder_url:root.webViewLink,spreadsheet_id:sheet.id,spreadsheet_url:sheet.webViewLink};
 }
 async function originalDocument(id){const {rows}=await pool.query("SELECT * FROM despesas_documents WHERE id=$1 AND state='complete'",[id]);if(!rows[0])throw apiError('Documento indisponível para cópia.');return rows[0];}
 async function copyDocument(c,id){
  const doc=await originalDocument(id),m=doc.metadata;
  const year=await folder(c,m.period.slice(0,4),c.folder_id,'ano-'+m.period.slice(0,4));
  const month=await folder(c,m.period,year.id,'mes-'+m.period);
  const linked=(await pool.query('SELECT file_id,url FROM despesas_google_files WHERE document_id=$1',[id])).rows[0];
  let f=linked?{id:linked.file_id,webViewLink:linked.url}:await findFile(c,"appProperties has { key='cn2oDocumentId' and value='"+escapeQuery(id)+"' }");
  if(f){
   // A previous attempt may have completed at Google before the database acknowledged it.
   const remote=await api(c,DRIVE+'/files/'+encodeURIComponent(f.id)+'?fields=id,webViewLink,size,appProperties');
   if(Number(remote.size)!==m.size||remote.appProperties?.sha256!==doc.hash)throw apiError('A cópia no Drive diverge do original. Confira o arquivo antes de repetir.');
   f=remote;
  }else{
   const rows=(await pool.query('SELECT part,bytes FROM despesas_parts WHERE document_id=$1 ORDER BY part',[id])).rows;
   const bytes=Buffer.concat(rows.map(p=>Buffer.from(p.bytes)));
   if(bytes.length!==m.size||hash(bytes)!==doc.hash)throw apiError('Original não passou na conferência de integridade para o Drive.');
   const boundary='cn2o_'+randomBytes(18).toString('hex');
   const meta={name:id.slice(0,8)+' — '+m.name,parents:[month.id],appProperties:{cn2oDocumentId:id,sha256:doc.hash}};
   const body=Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(meta)+'\r\n--'+boundary+'\r\nContent-Type: '+m.type+'\r\n\r\n'),bytes,Buffer.from('\r\n--'+boundary+'--\r\n')]);
   f=await api(c,'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',{method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body});
  }
  if(!f.id||!f.webViewLink)throw apiError('A cópia do comprovante no Drive não foi confirmada.');
  await pool.query('INSERT INTO despesas_google_files(document_id,file_id,url) VALUES($1,$2,$3) ON CONFLICT(document_id) DO UPDATE SET file_id=EXCLUDED.file_id,url=EXCLUDED.url',[id,f.id,f.webViewLink]);
 }
 async function updateSheet(c){
  const {categories,labels,eligible,pending}=await import('./google-sheet-values.mjs');
  const entries=(await pool.query("SELECT id,data,version,updated_at FROM despesas_entries WHERE COALESCE(data->>'demo','false')<>'true' ORDER BY data->>'paidDate',id")).rows;
  const docs=(await pool.query("SELECT d.id,d.metadata,d.ocr,d.created_by,f.url FROM despesas_documents d LEFT JOIN despesas_google_files f ON f.document_id=d.id WHERE d.state='complete' ORDER BY d.created_at,d.id")).rows;
  const headers=['ID','Data do pagamento','Mês do pagamento','Fornecedor','CPF/CNPJ','Descrição / finalidade','Natureza da despesa','Valor pago (R$)','Tratamento proposto','Pagamento conferido','Documentação conferida','Revisão fiscal','Dedutível revisado antes do limite (R$)','Responsável','Fundamento','Pendência','Comprovantes no Drive','IDs dos documentos','Versão','Última alteração'];
  const values=[headers,...entries.map(r=>{const e=r.data;return [r.id,e.paidDate,e.paidDate.slice(0,7),e.supplier,e.taxId,e.description,categories[e.category]||e.category,e.cents/100,labels[e.treatment]||e.treatment,e.paymentConfirmed?'Sim':'Não',e.docsConfirmed?'Sim':'Não',e.reviewed?'Sim':'Não',eligible(e)?e.cents/100:0,e.reviewer,e.reason,e.notes,e.docIds.map(id=>docs.find(d=>d.id===id)?.url||'Aguardando cópia no Drive').join('\n'),e.docIds.join(' | '),r.version,new Date(r.updated_at).toISOString()];})];
  const docValues=[['ID','Nome original','Tipo documental','Período de recebimento','Enviado por','Link do original no Drive','Situação da leitura','Situação do vínculo'],...docs.map(d=>[d.id,d.metadata.name,d.metadata.kind,d.metadata.period,d.created_by,d.url||'Aguardando cópia no Drive',d.ocr?.status||'Ainda não lido',entries.some(e=>e.data.docIds.includes(d.id))?'Vinculado':'Sem lançamento'])];
  const summary=new Map();for(const r of entries){const e=r.data,k=e.paidDate.slice(0,7)+'|'+e.category,g=summary.get(k)||[e.paidDate.slice(0,7),categories[e.category]||e.category,0,0,0,0,0];g[2]++;g[3]+=e.cents;g[4]+=eligible(e)?e.cents:0;g[5]+=e.treatment==='nao'&&e.reviewed?e.cents:0;g[6]+=pending(e)?1:0;summary.set(k,g);}
  const summaries=[['Mês','Natureza da despesa','Quantidade','Total pago (R$)','Dedutíveis revisadas antes do limite (R$)','Não dedutíveis revisadas (R$)','Lançamentos pendentes'],...[...summary.values()].map(g=>g.map((v,i)=>i>=3&&i<=5?v/100:v))];
  const metadata=await api(c,SHEETS+'/'+c.spreadsheet_id+'?fields=sheets(properties(sheetId,title,gridProperties))');
  const definitions=[['Lançamentos',values],['Documentos',docValues],['Resumo por natureza',summaries]],requests=[];
  let next=Math.max(0,...metadata.sheets.map(s=>s.properties.sheetId))+1;
  for(const [title,rows] of definitions){let prop=metadata.sheets.find(s=>s.properties.title===title)?.properties;
   if(!prop){prop={sheetId:next++,title,gridProperties:{rowCount:Math.max(1000,rows.length),columnCount:rows[0].length}};requests.push({addSheet:{properties:prop}});}
   requests.push({updateSheetProperties:{properties:{sheetId:prop.sheetId,gridProperties:{rowCount:Math.max(prop.gridProperties.rowCount,rows.length),columnCount:Math.max(prop.gridProperties.columnCount,rows[0].length),frozenRowCount:1}},fields:'gridProperties'}});
   requests.push({updateCells:{range:{sheetId:prop.sheetId},fields:'userEnteredValue'}});
   requests.push({updateCells:{start:{sheetId:prop.sheetId,rowIndex:0,columnIndex:0},rows:rows.map(row=>({values:row.map(v=>({userEnteredValue:typeof v==='number'?{numberValue:v}:{stringValue:String(v??'')}}))})),fields:'userEnteredValue'}});
   requests.push({repeatCell:{range:{sheetId:prop.sheetId,startRowIndex:0,endRowIndex:1},cell:{userEnteredFormat:{backgroundColor:{red:.39,green:.075,blue:.145},textFormat:{foregroundColor:{red:1,green:1,blue:1},bold:true},wrapStrategy:'WRAP'}},fields:'userEnteredFormat'}});
   requests.push({setBasicFilter:{filter:{range:{sheetId:prop.sheetId,startRowIndex:0,endRowIndex:Math.max(2,rows.length),endColumnIndex:rows[0].length}}}});
   requests.push({updateDimensionProperties:{range:{sheetId:prop.sheetId,dimension:'COLUMNS',startIndex:0,endIndex:rows[0].length},properties:{pixelSize:170},fields:'pixelSize'}});
   const columns=title==='Lançamentos'?[7,12]:title==='Resumo por natureza'?[3,4,5]:[];
   for(const column of columns)requests.push({repeatCell:{range:{sheetId:prop.sheetId,startRowIndex:1,startColumnIndex:column,endColumnIndex:column+1},cell:{userEnteredFormat:{numberFormat:{type:'NUMBER',pattern:'"R$" #,##0.00'}}},fields:'userEnteredFormat.numberFormat'}});
  }
  await post(c,SHEETS+'/'+c.spreadsheet_id+':batchUpdate',{requests});
 }
 async function enqueueAll(){
  await pool.query("INSERT INTO despesas_google_jobs(entity,record_id) SELECT 'document',id FROM despesas_documents WHERE state='complete' ON CONFLICT(entity,record_id) DO UPDATE SET generation=despesas_google_jobs.generation+1,attempts=0,next_attempt=now()");
  await pool.query("INSERT INTO despesas_google_jobs(entity,record_id) SELECT 'entry',id FROM despesas_entries ON CONFLICT(entity,record_id) DO UPDATE SET generation=despesas_google_jobs.generation+1,attempts=0,next_attempt=now()");
 }
 async function run(){
  if(busy)return;busy=true;let client,locked=false;
  try{
   await initialize();let c=await connection();if(!c?.credentials?.refresh_token)return;
   client=await pool.connect();locked=(await client.query("SELECT pg_try_advisory_lock(hashtext('cn2o-despesas-google-sync')) AS locked")).rows[0].locked;if(!locked)return;
   if(!c.folder_id||!c.spreadsheet_id)c=await resources(c);
   const jobs=(await pool.query('SELECT * FROM despesas_google_jobs WHERE next_attempt<=now() ORDER BY entity DESC,record_id LIMIT 15')).rows;
   if(!jobs.length)return;
   const done=[];for(const job of jobs){try{if(job.entity==='document')await copyDocument(c,job.record_id);done.push(job);}catch(e){await pool.query("UPDATE despesas_google_jobs SET attempts=attempts+1,next_attempt=now()+least(3600,power(2,least(attempts,10))*20)*interval '1 second' WHERE entity=$1 AND record_id=$2 AND generation=$3",[job.entity,job.record_id,job.generation]);throw e;}}
   await updateSheet(c);
   for(const job of done)await pool.query('DELETE FROM despesas_google_jobs WHERE entity=$1 AND record_id=$2 AND generation=$3',[job.entity,job.record_id,job.generation]);
   await pool.query('UPDATE despesas_google_connection SET last_sync=now(),last_error=NULL WHERE id=1');
  }catch(e){try{await pool.query('UPDATE despesas_google_connection SET last_error=$1 WHERE id=1',[e.publicMessage||'Sincronização pendente. Os originais e lançamentos permanecem salvos no Hub.']);}catch{}}
  finally{if(locked)await client.query("SELECT pg_advisory_unlock(hashtext('cn2o-despesas-google-sync'))").catch(()=>{});client?.release();busy=false;}
 }
 function poke(){void run();if(!timer){timer=setInterval(()=>void run(),20000);timer.unref?.();}}
 async function status(){await initialize();const c=await connection(),jobs=(await pool.query('SELECT count(*)::integer AS count FROM despesas_google_jobs')).rows[0].count;return {configured:!!c?.credentials?.client_id,connected:!!c?.credentials?.refresh_token,account:c?.account||null,expectedAccount:EXPECTED,folderUrl:c?.folder_url||null,spreadsheetUrl:c?.spreadsheet_url||null,lastSync:c?.last_sync||null,error:c?.last_error||null,pending:jobs,callback};}
 async function configure(body){await initialize();const v=body.web||body;if(typeof v.client_id!=='string'||!/^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(v.client_id)||typeof v.client_secret!=='string'||v.client_secret.length<10||v.client_secret.length>500)throw apiError('Envie o arquivo JSON do cliente OAuth Web criado no Google Cloud.');const old=await connection();if(old?.credentials?.refresh_token)throw apiError('Esta integração já está conectada. Preserve a configuração existente.');await pool.query("INSERT INTO despesas_google_connection(id,credentials) VALUES(1,$1::jsonb) ON CONFLICT(id) DO UPDATE SET credentials=EXCLUDED.credentials,updated_at=now()",[JSON.stringify({client_id:v.client_id,client_secret:v.client_secret})]);access=null;return {configured:true};}
 async function connect(){await initialize();const c=await connection();if(!c?.credentials.client_id)throw apiError('Configure o cliente Google antes de conectar.');const state=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');await pool.query('DELETE FROM despesas_google_oauth WHERE expires_at<now()');await pool.query("INSERT INTO despesas_google_oauth(state_hash,verifier,client_id,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",[hash(state),verifier,c.credentials.client_id]);return {url:'https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({client_id:c.credentials.client_id,redirect_uri:callback,response_type:'code',scope:'openid email https://www.googleapis.com/auth/drive.file',access_type:'offline',prompt:'consent select_account',state,code_challenge:challenge,code_challenge_method:'S256',login_hint:EXPECTED})};}
 async function finish(query){
  await initialize();if(typeof query.state!=='string'||query.state.length>200)throw apiError('Autorização Google inválida ou expirada.');
  const pending=(await pool.query('DELETE FROM despesas_google_oauth WHERE state_hash=$1 AND expires_at>now() RETURNING verifier,client_id',[hash(query.state)])).rows[0];if(!pending)throw apiError('Autorização Google inválida ou expirada.');
  if(query.error||typeof query.code!=='string'||query.code.length>2000)throw apiError('A conexão Google não foi autorizada.');
  const c=await connection();if(c.credentials.client_id!==pending.client_id)throw apiError('A configuração foi alterada. Inicie uma nova conexão.');
  const t=await jsonRequest('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:query.code,client_id:c.credentials.client_id,client_secret:c.credentials.client_secret,redirect_uri:callback,code_verifier:pending.verifier})});
  const profile=await jsonRequest('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:'Bearer '+t.access_token}});
  if(profile.email?.toLowerCase()!==EXPECTED||profile.email_verified!==true){await fetcher('https://oauth2.googleapis.com/revoke',{method:'POST',body:new URLSearchParams({token:t.refresh_token||t.access_token}),signal:AbortSignal.timeout(15000)}).catch(()=>{});throw apiError('Selecione exclusivamente '+EXPECTED+'. Outra conta não foi vinculada.');}
  if(!t.refresh_token)throw apiError('Google não concedeu acesso para sincronização contínua. Reconecte com autorização.');
  await pool.query('UPDATE despesas_google_connection SET credentials=$1::jsonb,account=$2,last_error=NULL,updated_at=now() WHERE id=1',[JSON.stringify({...c.credentials,refresh_token:t.refresh_token}),EXPECTED]);access=null;await enqueueAll();poke();
 }
 return {status,configure,connect,finish,poke,run,enqueueAll,stop:()=>{if(timer)clearInterval(timer);timer=null;}};
}
module.exports={createGoogleSync,EXPECTED,CALLBACK};
