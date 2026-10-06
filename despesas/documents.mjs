import { createHash } from 'node:crypto';
import { database } from './database.mjs';
import { requireUser, reply, failure, demand, uuid } from './auth.mjs';
import { signature } from './validation.mjs';
const chunkSize=1024*1024;
export async function processRequest(request,{authenticate=requireUser,db=null,store=null}={}){
  try{
    const user=await authenticate(request),url=new URL(request.url),action=url.searchParams.get('action'),id=url.searchParams.get('id');
    db??=database();demand(store,'Armazenamento indisponível.',503);
    if(action==='reserve'&&request.method==='POST'){
      const doc=await request.json();demand(uuid(doc.id)&&/^[a-f0-9]{64}$/.test(doc.hash||''),'Documento inválido.');
      demand(typeof doc.name==='string'&&doc.name.length>0&&doc.name.length<500,'Nome inválido.');
      demand(['Comprovante de pagamento','Nota fiscal ou recibo','Contrato','Ordem de serviço','Outro documento'].includes(doc.kind),'Tipo documental inválido.');
      demand(/^\d{4}-(0[1-9]|1[0-2])$/.test(doc.period||''),'Período inválido.');
      demand(Number.isSafeInteger(doc.size)&&doc.size>0&&doc.size<=50*1024*1024&&['application/pdf','image/png','image/jpeg','image/webp'].includes(doc.type),'Arquivo inválido ou acima de 50 MB.');
      const metadata={name:doc.name,kind:doc.kind,period:doc.period,size:doc.size,type:doc.type};
      await db.sql`INSERT INTO despesas_documents(id,hash,metadata,created_by) VALUES (${doc.id}::uuid,${doc.hash},${JSON.stringify(metadata)}::jsonb,${user.login}) ON CONFLICT(hash) DO NOTHING`;
      const [saved]=await db.sql`SELECT id,state,created_by FROM despesas_documents WHERE hash=${doc.hash}`;
      demand(saved,'Falha ao reservar documento.',503);
      if(saved.state==='complete')return reply({id:saved.id,duplicate:true});
      demand(saved.created_by===user.login,'Este arquivo já está sendo enviado por outra pessoa.',409);
      return reply({id:saved.id,duplicate:false});
    }
    demand(uuid(id),'Documento inválido.');
    const [doc]=await db.sql`SELECT * FROM despesas_documents WHERE id=${id}::uuid`;
    demand(doc,'Documento não encontrado.',404);
    const n=Number(url.searchParams.get('chunk')),count=Math.ceil(doc.metadata.size/chunkSize);
    if(action==='chunk'){
      demand(Number.isInteger(n)&&n>=0&&n<count,'Parte inválida.');
      const key=id+'/'+n;
      if(request.method==='GET'){
        demand(doc.state==='complete','Recebimento incompleto.',409);
        const bytes=await store.get(key,{type:'arrayBuffer'});demand(bytes,'Parte do arquivo indisponível.',503);
        return new Response(bytes,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'private, no-store'}});
      }
      if(request.method==='PUT'){
        demand(doc.state==='uploading'&&doc.created_by===user.login,'Envio indisponível para este usuário.',409);
        const bytes=Buffer.from(await request.arrayBuffer());
        demand(bytes.length===Math.min(chunkSize,doc.metadata.size-n*chunkSize),'Parte do arquivo incompleta.');
        const digest=createHash('sha256').update(bytes).digest('hex');
        const saved=await store.set(key,bytes,{onlyIfNew:true,metadata:{digest}});
        if(!saved.modified){const previous=await store.getMetadata(key);demand(previous?.metadata?.digest===digest||previous?.digest===digest,'Conteúdo divergente no envio. Selecione novamente o original.',409);}
        return reply({saved:true});
      }
    }
    if(action==='finish'&&request.method==='POST'){
      if(doc.state==='complete')return reply({saved:true,version:doc.version});
      demand(doc.created_by===user.login,'Envio não autorizado.',403);
      const hash=createHash('sha256');let total=0;
      for(let i=0;i<count;i++){
        const part=await store.get(id+'/'+i,{type:'arrayBuffer'});demand(part,'Uma parte não chegou. Reenvie o original.',409);
        const bytes=Buffer.from(part);if(i===0)demand(signature(bytes)===doc.metadata.type,'O conteúdo não corresponde ao tipo do arquivo.');hash.update(bytes);total+=bytes.length;
      }
      demand(total===doc.metadata.size&&hash.digest('hex')===doc.hash,'O original recebido não passou na conferência de integridade.',409);
      await db.sql`UPDATE despesas_documents SET state='complete',updated_at=now() WHERE id=${id}::uuid`;
      return reply({saved:true,version:doc.version});
    }
    if(action==='ocr'&&request.method==='POST'){
      demand(doc.state==='complete','Documento ainda incompleto.',409);
      const input=await request.json();demand(input.ocr&&JSON.stringify(input.ocr).length<3000000,'Leitura acima do limite.',413);
      const saved=await db.sql`UPDATE despesas_documents SET ocr=${JSON.stringify(input.ocr)}::jsonb,version=version+1,updated_at=now() WHERE id=${id}::uuid AND version=${input.version} RETURNING version`;
      demand(saved.length,'Outra pessoa atualizou a leitura deste documento. Atualize o painel.',409);
      return reply({version:saved[0].version});
    }
    return reply({error:'Método não permitido.'},405);
  }catch(error){return failure(error);}
}
export default async function handler(request){return processRequest(request);}
