'use strict';
const {createHash}=require('node:crypto');
const {profile}=require('./workspaces');
const validId=id=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id||'');
const reject=(message,status=400)=>{throw Object.assign(new Error(message),{publicMessage:message,status});};
const table=(workspace,name)=>profile(workspace).prefix+'despesas_'+name;
function evidence(doc){
  const text=JSON.stringify({name:doc.metadata?.name,ocr:doc.ocr}).normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const signals=[];
  if(/bravo[\s_]+patrimonial/i.test(text))signals.push('Nome empresarial Bravo Patrimonial');
  if(/62\D?564\D?260\D?0001\D?47/.test(text))signals.push('CNPJ 62.564.260/0001-47');
  return signals;
}
async function audit({pool,workspace}){
  const docs=(await pool.query("SELECT id,hash,metadata,ocr,version FROM despesas_documents WHERE state='complete' ORDER BY created_at,id")).rows;
  const entries=(await pool.query('SELECT id,data,version FROM despesas_entries ORDER BY updated_at,id')).rows;
  return {workspace,scannedAt:new Date().toISOString(),documentCount:docs.length,entryCount:entries.length,
    documents:docs.map(d=>({id:d.id,name:d.metadata.name,period:d.metadata.period,hash:d.hash,version:d.version,
      routing:d.metadata.routing||null,signals:evidence(d),linkedEntryIds:entries.filter(e=>!e.data.voided&&e.data.docIds.includes(d.id)).map(e=>e.id)})),
    entries:entries.map(e=>({id:e.id,supplier:e.data.supplier,description:e.data.description,cents:e.data.cents,
      paidDate:e.data.paidDate,referencePeriod:e.data.referencePeriod,voided:!!e.data.voided,docIds:e.data.docIds,
      routing:e.data.routing||null,signals:evidence({metadata:{name:e.data.description},ocr:{text:e.data.notes}})}))};
}
async function transfer({pool,source,target,input,actor}){
  profile(source);profile(target);
  if(source===target)reject('Escolha outro controle.');
  if(!['document','entry'].includes(input.kind)||!validId(input.id))reject('Registro inválido.');
  if(typeof input.reason!=='string'||input.reason.trim().length<10||input.reason.length>2000)reject('Registre a evidência da titularidade e o motivo da transferência.');
  if(!Number.isInteger(input.version)||input.version<1)reject('Atualize o painel antes de transferir.');
  const client=await pool.connect(),reason=input.reason.trim(),at=new Date().toISOString();
  const s=name=>table(source,name),t=name=>table(target,name);
  const getDoc=async id=>(await client.query(`SELECT * FROM ${s('documents')} WHERE id=$1 FOR UPDATE`,[id])).rows[0];
  const ensureDestination=async doc=>{
    if(!doc||doc.state!=='complete')reject('Original indisponível ou incompleto.',409);
    if(doc.metadata.routing?.destination&&doc.metadata.routing.destination!==source){
      if(doc.metadata.routing.destination===target)return doc.metadata.routing.targetDocumentId;
      reject('Documento já destinado a outro controle.',409);
    }
    const parts=(await client.query(`SELECT part,digest,bytes FROM ${s('parts')} WHERE document_id=$1 ORDER BY part`,[doc.id])).rows;
    const hash=createHash('sha256');let total=0;
    for(const [i,p] of parts.entries()){
      const bytes=Buffer.from(p.bytes);if(p.part!==i||createHash('sha256').update(bytes).digest('hex')!==p.digest)reject('Uma parte do original diverge. Transferência cancelada.',409);
      hash.update(bytes);total+=bytes.length;
    }
    if(total!==doc.metadata.size||hash.digest('hex')!==doc.hash)reject('O original não passou na conferência SHA-256. Transferência cancelada.',409);
    const existing=(await client.query(`SELECT id,state,metadata FROM ${t('documents')} WHERE hash=$1`,[doc.hash])).rows[0];
    if(existing&&existing.state!=='complete')reject('O mesmo original ainda está sendo recebido no destino.',409);
    const destinationId=existing?.id||doc.id;
    if(!existing){
      const metadata={...doc.metadata,workspace:target,routing:{source,sourceDocumentId:doc.id,movedAt:at,by:actor,reason}};
      await client.query(`INSERT INTO ${t('documents')}(id,hash,metadata,state,ocr,version,created_by,created_at) VALUES($1,$2,$3::jsonb,'complete',$4::jsonb,1,$5,$6)`,[destinationId,doc.hash,JSON.stringify(metadata),JSON.stringify(doc.ocr),doc.created_by,doc.created_at]);
      for(const p of parts)await client.query(`INSERT INTO ${t('parts')}(document_id,part,digest,bytes) VALUES($1,$2,$3,$4)`,[destinationId,p.part,p.digest,p.bytes]);
    }else if(existing.metadata.routing?.destination){
      if(existing.metadata.routing.destination!==source)reject('O original no destino tem outra transferência pendente.',409);
      const metadata={...existing.metadata,workspace:target,routing:{source,sourceDocumentId:doc.id,movedAt:at,by:actor,reason}};
      await client.query(`UPDATE ${t('documents')} SET metadata=$2::jsonb,version=version+1,updated_at=now() WHERE id=$1`,[destinationId,JSON.stringify(metadata)]);
    }
    const routing={destination:target,targetDocumentId:destinationId,movedAt:at,by:actor,reason};
    await client.query(`UPDATE ${s('documents')} SET metadata=$2::jsonb,version=version+1,updated_at=now() WHERE id=$1`,[doc.id,JSON.stringify({...doc.metadata,routing})]);
    for(const name of [s('audit'),t('audit')])await client.query(`INSERT INTO ${name}(record_id,record_type,version,actor,snapshot) VALUES($1,'routing',$2,$3,$4::jsonb)`,[doc.id,doc.version+1,actor,JSON.stringify({source,target,hash:doc.hash,metadata:doc.metadata,routing})]);
    await client.query(`DELETE FROM ${s('google_jobs')} WHERE entity='document' AND record_id=$1`,[doc.id]);
    // An entry job also refreshes an emptied source spreadsheet, without copying a moved original.
    await client.query(`INSERT INTO ${s('google_jobs')}(entity,record_id) VALUES('entry',$1) ON CONFLICT(entity,record_id) DO UPDATE SET generation=${s('google_jobs')}.generation+1,next_attempt=now()`,[doc.id]);
    return destinationId;
  };
  try{
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('expense-workspace-transfer'))");
    let result;
    if(input.kind==='document'){
      const doc=await getDoc(input.id);
      if(!doc)reject('Documento não encontrado.',404);
      if(doc.metadata.routing?.destination===target){await client.query('COMMIT');return {saved:true,reused:true,target,documentId:doc.metadata.routing.targetDocumentId};}
      if(doc.version!==input.version)reject('Outra pessoa alterou o documento. Atualize antes de transferir.',409);
      const links=(await client.query(`SELECT id FROM ${s('entries')} WHERE data->'docIds' ? $1 AND COALESCE(data->>'voided','false')<>'true'`,[doc.id])).rows;
      if(links.length)reject('Documento vinculado a lançamento ativo. Transfira o lançamento completo após conferir todos os comprovantes.',409);
      result={saved:true,target,documentId:await ensureDestination(doc)};
    }else{
      const entry=(await client.query(`SELECT * FROM ${s('entries')} WHERE id=$1 FOR UPDATE`,[input.id])).rows[0];
      if(!entry)reject('Lançamento não encontrado.',404);
      if(entry.data.routing?.destination===target){await client.query('COMMIT');return {saved:true,reused:true,target,entryId:entry.data.routing.targetEntryId};}
      if(entry.version!==input.version||entry.data.voided)reject('Lançamento alterado ou anulado. Confira o histórico antes de transferir.',409);
      const old=(await client.query(`SELECT id,data FROM ${t('entries')} WHERE id=$1`,[entry.id])).rows[0];
      if(old&&!(old.data.voided&&old.data.routing?.destination===source))reject('O identificador já existe no destino. Concilie antes de repetir.',409);
      const docIds=[];
      if(input.replacementDocumentIds!==undefined){
        const ids=input.replacementDocumentIds;
        if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(id=>!validId(id))||new Set(ids).size!==ids.length)reject('Selecione os comprovantes segregados já arquivados no destino.');
        const available=(await client.query(`SELECT id FROM ${t('documents')} WHERE id=ANY($1::uuid[]) AND state='complete' AND COALESCE(metadata->'routing'->>'destination',$2)=$2`,[ids,target])).rows;
        if(available.length!==ids.length)reject('Um comprovante selecionado não está disponível no controle de destino.',409);
        docIds.push(...ids);
      }else{
        for(const id of entry.data.docIds){
          const others=(await client.query(`SELECT id FROM ${s('entries')} WHERE id<>$2 AND data->'docIds' ? $1 AND COALESCE(data->>'voided','false')<>'true'`,[id,entry.id])).rows;
          if(others.length)reject('Há comprovante compartilhado. Arquive as páginas segregadas no destino e selecione-as na transferência.',409);
          docIds.push(await ensureDestination(await getDoc(id)));
        }
      }
      const routing={source,sourceEntryId:entry.id,movedAt:at,by:actor,reason,
        ...(input.replacementDocumentIds?{retainedSourceDocumentIds:entry.data.docIds,replacementDocumentIds:docIds}:{})};
      const data={...entry.data,workspace:target,docIds,reviewed:false,docsConfirmed:false,treatment:'analise',
        reason:'Revisão contábil do controle de destino pendente. '+reason,
        notes:entry.data.notes+' | Transferido de '+profile(source).name+'; revisão contábil pendente.',routing};
      if(old)await client.query(`UPDATE ${t('entries')} SET data=$2::jsonb,version=version+1,updated_by=$3,updated_at=now() WHERE id=$1`,[entry.id,JSON.stringify(data),actor]);
      else await client.query(`INSERT INTO ${t('entries')}(id,data,updated_by) VALUES($1,$2::jsonb,$3)`,[entry.id,JSON.stringify(data),actor]);
      const historical={...entry.data,reviewed:false,voided:true,voidReason:'Transferido para '+profile(target).name+'. '+reason,
        routing:{destination:target,targetEntryId:entry.id,movedAt:at,by:actor,reason}};
      await client.query(`UPDATE ${s('entries')} SET data=$2::jsonb,version=version+1,updated_by=$3,updated_at=now() WHERE id=$1`,[entry.id,JSON.stringify(historical),actor]);
      result={saved:true,target,entryId:entry.id,documentIds:docIds};
    }
    await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
}
module.exports={audit,transfer,evidence};
