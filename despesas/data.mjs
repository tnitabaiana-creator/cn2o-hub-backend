import { database } from './database.mjs';
import { requireUser, reply, failure, demand } from './auth.mjs';
import { validateEntry } from './validation.mjs';
export async function processRequest(request,{authenticate=requireUser,db=null}={}){
  try{
    const user=await authenticate(request);
    db??=database();
    if(request.method==='GET'){
      const [docs,entries]=await Promise.all([
        db.sql`SELECT d.id,d.hash,d.metadata,d.ocr,d.version,d.created_by,d.created_at,f.url AS drive_url FROM despesas_documents d LEFT JOIN despesas_google_files f ON f.document_id=d.id WHERE d.state='complete' ORDER BY d.created_at DESC`,
        db.sql`SELECT e.id,e.data,e.version,e.updated_at,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('at',a.at,'by',a.actor,'snapshot',a.snapshot) ORDER BY a.sequence) FROM despesas_audit a WHERE a.record_id=e.id),'[]'::jsonb) AS history
          FROM despesas_entries e ORDER BY e.updated_at DESC`
      ]);
      return reply({user:{id:user.id,login:user.login,name:user.name||user.login},documents:docs.map(d=>({...d.metadata,id:d.id,hash:d.hash,ocr:d.ocr,version:d.version,person:d.created_by,createdAt:d.created_at,driveUrl:d.drive_url||null})),entries:entries.map(e=>({...e.data,id:e.id,version:e.version,updatedAt:e.updated_at,history:e.history}))});
    }
    if(request.method==='POST'){
      demand(Number(request.headers.get('content-length')||0)<300000,'Lançamento muito grande.',413);
      const input=await request.json(),data=validateEntry(input);
      data.reviewer=user.login;data.demo=false;
      if(data.docIds.length){const docs=await db.sql`SELECT id FROM despesas_documents WHERE id=ANY(${data.docIds}::uuid[]) AND state='complete'`;demand(docs.length===data.docIds.length,'Um documento vinculado ainda não foi recebido integralmente.');}
      const oldVersion=input.version||0;let rows;
      if(oldVersion){
        rows=await db.sql`UPDATE despesas_entries SET data=${JSON.stringify(data)}::jsonb,version=version+1,updated_by=${user.login},updated_at=now() WHERE id=${data.id}::uuid AND version=${oldVersion} RETURNING version`;
      }else{
        rows=await db.sql`INSERT INTO despesas_entries(id,data,updated_by) VALUES (${data.id}::uuid,${JSON.stringify(data)}::jsonb,${user.login}) ON CONFLICT(id) DO NOTHING RETURNING version`;
      }
      demand(rows.length===1,'Outra pessoa alterou este lançamento. Atualize o painel e confira as alterações antes de salvar novamente.',409);
      return reply({version:rows[0].version});
    }
    return reply({error:'Método não permitido.'},405);
  }catch(error){if(error.code==='23505')return reply({error:'Possível duplicidade: já existe lançamento com o mesmo fornecedor, valor e data.'},409);return failure(error);}
}
export default async function handler(request){return processRequest(request);}
