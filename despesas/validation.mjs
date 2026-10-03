import { categories } from './expense-exports.mjs';
import { demand, uuid } from './auth.mjs';
const bounded=(value,size)=>typeof value==='string'&&value.trim().length>0&&value.length<=size;
export function validDate(value){return /^\d{4}-\d{2}-\d{2}$/.test(value||'')&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;}
export function validateEntry(input){
  demand(uuid(input.id),'Identificador inválido.');
  demand(bounded(input.supplier,300)&&bounded(input.description,2000),'Informe fornecedor e descrição.');
  demand(Number.isSafeInteger(input.cents)&&input.cents>0&&input.cents<100000000000,'Valor inválido.');
  demand(validDate(input.paidDate),'Data de pagamento inválida.');
  demand(['dedutivel','nao','analise','pendente'].includes(input.treatment),'Tratamento fiscal inválido.');
  demand(Object.hasOwn(categories,input.category),'Categoria inválida.');
  demand(Array.isArray(input.docIds)&&input.docIds.length<=100&&input.docIds.every(uuid)&&new Set(input.docIds).size===input.docIds.length,'Documentos inválidos.');
  demand(typeof input.taxId==='string'&&input.taxId.length<=40&&typeof input.reason==='string'&&input.reason.length<=10000&&typeof input.notes==='string'&&input.notes.length<=10000,'Texto inválido.');
  for(const key of ['paymentConfirmed','docsConfirmed','reviewed'])demand(typeof input[key]==='boolean','Conferência inválida.');
  if(input.reviewed)demand(bounded(input.reason,10000)&&!['pendente','analise'].includes(input.treatment),'Registre a justificativa antes de concluir a revisão.');
  if(input.reviewed&&input.treatment==='dedutivel')demand(input.paymentConfirmed&&input.docsConfirmed&&input.docIds.length>0,'Dedução revisada exige pagamento e documentação conferidos.');
  demand(!input.demo,'Exemplos não podem ser salvos no acervo compartilhado.');
  const data=Object.fromEntries(['id','supplier','description','taxId','cents','paidDate','category','treatment','reason','notes','docIds','paymentConfirmed','docsConfirmed','reviewed'].map(key=>[key,input[key]]));
  data.fieldSources=input.fieldSources&&typeof input.fieldSources==='object'?input.fieldSources:{};
  demand(JSON.stringify(data.fieldSources).length<100000,'Fontes de leitura muito extensas.');
  return data;
}
export function signature(bytes){
  if(bytes.subarray(0,5).toString()==='%PDF-')return 'application/pdf';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
  return null;
}
