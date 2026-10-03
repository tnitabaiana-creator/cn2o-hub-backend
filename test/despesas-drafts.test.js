const test=require('node:test');
const assert=require('node:assert/strict');
const sample={id:'00000000-0000-4000-8000-000000000001',supplier:'Fornecedor fictício',description:'Despesa fictícia a conferir',cents:12300,paidDate:'',referencePeriod:'2026-06',treatment:'analise',category:'contabil',docIds:[],taxId:'',reason:'Conferir',notes:'Pagamento pendente',paymentConfirmed:false,docsConfirmed:false,reviewed:false};
test('pré-lançamento exige mês e bloqueia pagamento confirmado ou aprovação sem data',async()=>{
 const {validateEntry}=await import('../despesas/validation.mjs');
 assert.equal(validateEntry(sample).referencePeriod,'2026-06');
 for(const patch of [{referencePeriod:''},{referencePeriod:'2026-13'},{paymentConfirmed:true},{reviewed:true}])assert.throws(()=>validateEntry({...sample,...patch}));
 assert.equal(validateEntry({...sample,paidDate:'2026-07-02'}).referencePeriod,'2026-07');
});
test('exportação identifica pagamento pendente e inclui pré-lançamento apenas nos meses abrangidos',async()=>{
 const {selectExpenses,detailCSV,reportHTML}=await import('../despesas/expense-exports.mjs');
 const e={...sample,reviewer:'cesar.bravo'};
 assert.equal(selectExpenses([e],{from:'2026-06-01',to:'2026-06-30'}).length,1);
 assert.equal(selectExpenses([e],{from:'2026-07-01',to:'2026-07-31'}).length,0);
 assert(detailCSV([e],[]).includes('Pagamento pendente'));
 const report=reportHTML([e],[],{from:'2026-06-01',to:'2026-06-30'});
 assert(report.includes('data pendente'));assert(report.includes('Total registrado'));
});
test('anulação exige motivo, conserva valores e originais, e impede soma e aprovação fiscal',async()=>{
 const {validateEntry}=await import('../despesas/validation.mjs');
 const {selectExpenses,detailCSV,totals,reportHTML}=await import('../despesas/expense-exports.mjs');
 assert.throws(()=>validateEntry({...sample,voided:true}));
 assert.throws(()=>validateEntry({...sample,paidDate:'2026-06-02',treatment:'nao',reviewed:true,voided:true,voidReason:'Duplicidade'}));
 const active={...sample,reviewer:'cesar.bravo'},cancelled=validateEntry({...sample,id:'00000000-0000-4000-8000-000000000002',voided:true,voidReason:'Mesma nota do registro original'});
 assert.equal(cancelled.cents,sample.cents);assert.deepEqual(cancelled.docIds,sample.docIds);
 const filters={from:'2026-06-01',to:'2026-06-30'};
 assert.equal(selectExpenses([active,cancelled],filters).length,1);
 assert.equal(totals([active,cancelled]).total,sample.cents);
 assert(!detailCSV([active,cancelled],[]).includes(cancelled.id));
 assert(!reportHTML([active,cancelled],[],filters).includes(cancelled.id));
 assert.equal(validateEntry({...cancelled,voided:false}).voided,false);
});
