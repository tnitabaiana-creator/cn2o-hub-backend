import { requireUser, reply, failure, demand } from './auth.mjs';
import { database } from './database.mjs';
import { settings } from './ocr-config.mjs';
export function validateImage(body){
  if(!body||typeof body.image!=='string'||body.image.length>3500000||!body.image.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.image))return false;
  const bytes=Buffer.from(body.image,'base64');
  return bytes.length>10&&((bytes[0]===255&&bytes[1]===216&&bytes[2]===255)||(bytes[0]===137&&bytes.subarray(1,4).toString()==='PNG'));
}
export async function processRequest(request,{env=process.env,fetcher=fetch,authenticate=requireUser,reservePage=async limit=>{
  const db=database();
  const rows=await db.sql`INSERT INTO despesas_ocr_usage(month,count) VALUES (date_trunc('month',now())::date,1)
    ON CONFLICT(month) DO UPDATE SET count=despesas_ocr_usage.count+1 WHERE despesas_ocr_usage.count<${limit} RETURNING count`;
  return rows.length>0;
}}={}){
  try{
    demand(request.method==='POST','Método não permitido.',405);
    await authenticate(request);
    const config=settings(env);demand(config.enabled,'Google OCR ainda não configurado.',503);
    demand(request.headers.get('content-type')?.startsWith('application/json'),'Envie JSON.',415);
    const raw=await request.text();demand(raw.length<3600000,'Página muito grande.',413);
    let body;try{body=JSON.parse(raw);}catch{throw Object.assign(new Error('JSON inválido.'),{status:400});}
    demand(validateImage(body),'Imagem inválida.',400);
    demand(await reservePage(config.monthlyPageLimit),'O limite mensal de páginas do Google foi atingido. Use o OCR local ou ajuste o limite com o administrador.',429);
    const response=await fetcher('https://vision.googleapis.com/v1/images:annotate',{method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':env.GCP_VISION_KEY},body:JSON.stringify({requests:[{image:{content:body.image},features:[{type:'DOCUMENT_TEXT_DETECTION'}],imageContext:{languageHints:['pt']}}]}),signal:AbortSignal.timeout(30000)});
    demand(response.ok,'O Google não concluiu a leitura. Confira API, faturamento e cota.',502);
    const result=await response.json(),annotation=result.responses?.[0];
    demand(annotation&&!annotation.error,'O Google retornou uma falha de leitura.',502);
    const text=annotation.fullTextAnnotation?.text||annotation.textAnnotations?.[0]?.description||'';
    return reply({text,confidence:annotation.fullTextAnnotation?.pages?.[0]?.confidence??null,provider:'Google Cloud Vision',empty:!text.trim()});
  }catch(error){return failure(error);}
}
export default async function handler(request){return processRequest(request);}
