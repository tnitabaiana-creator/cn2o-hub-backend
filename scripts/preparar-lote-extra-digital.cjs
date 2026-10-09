'use strict';
/** Preparação exclusivamente offline. Não conecta ao Hub, CTN ou banco. */
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {validarLote} = require('../atos-lavrados-db');
const REPO = path.resolve(__dirname,'..');
const sha = x => createHash('sha256').update(x).digest('hex');
const fail = message => { throw new Error(message); };
function canonical(x) { return Array.isArray(x) ? '['+x.map(canonical).join(',')+']' : x && typeof x==='object' ? '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}' : JSON.stringify(x); }
function uuid5(value) {
 const ns=Buffer.from('6ba7b8119dad11d180b400c04fd430c8','hex');
 const b=createHash('sha1').update(ns).update(value).digest().subarray(0,16); b[6]=(b[6]&15)|80;b[8]=(b[8]&63)|128;
 const h=b.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function civil(v) {
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)fail('Data civil inválida; use AAAA-MM-DD.');return v;
}
function cutoff(v) {
 if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/.test(v)||!Number.isFinite(Date.parse(v)))fail('corte_em exige instante ISO real com fuso.');
 civil(v.slice(0,10)); const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(v));
 const get=t=>parts.find(p=>p.type===t).value;return {iso:v,dia:`${get('year')}-${get('month')}-${get('day')}`};
}
const lastDay=m=>new Date(Date.UTC(+m.slice(0,4),+m.slice(5),0)).toISOString().slice(0,10);
function previousMonth(m) { const d=new Date(m+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()-1);return d.toISOString().slice(0,7); }
function decode(bytes, requested='auto') {
 let encoding=requested;
 if(encoding==='auto') {
  if(bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf)encoding='utf-8';
  else {try {new TextDecoder('utf-8',{fatal:true}).decode(bytes);encoding='utf-8';}catch {encoding='windows-1252';}}
 }
 if(!['utf-8','windows-1252','cp1252'].includes(encoding))fail('Encoding permitido: auto, utf-8 ou windows-1252.');
 if(encoding==='cp1252')encoding='windows-1252';
 let text;try{text=new TextDecoder(encoding,{fatal:true}).decode(bytes);}catch{fail('Arquivo incompatível com o encoding declarado.');}
 return {encoding,text:text.replace(/^\uFEFF/,'')};
}
function csv(text) {
 const rows=[];let row=[],field='',quoted=false,closed=false;
 function push(){row.push(field);field='';closed=false;}
 for(let i=0;i<text.length;i++) {
  const c=text[i];
  if(quoted) {if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else {quoted=false;closed=true;}}else field+=c;continue;}
  if(c==='"') {if(field||closed)fail('Aspas inválidas no CSV.');quoted=true;continue;}
  if(c===';'){push();continue;}
  if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;push();rows.push(row);row=[];continue;}
  if(closed)fail('Texto depois das aspas de fechamento no CSV.');field+=c;
 }
 if(quoted)fail('Campo entre aspas não terminado no CSV.');
 if(field||row.length||closed){push();rows.push(row);}
 while(rows.length&&rows.at(-1).length===1&&rows.at(-1)[0]==='')rows.pop();
 if(!rows.length)fail('CSV sem cabeçalho.');
 const headers=rows.shift();
 if(new Set(headers).size!==headers.length||headers.some(h=>!h||['__proto__','constructor','prototype'].includes(h)))fail('Cabeçalhos vazios, repetidos ou proibidos.');
 const required=['Acervo','Documento','Sub-tipo','Minuta','Protocolo','Data','Livro','Folha','Situação'];
 if(required.some(h=>!headers.includes(h)))fail('Cabeçalhos obrigatórios do CTN ausentes. A primeira linha deve ser o cabeçalho.');
 return {headers,rows:rows.map((r,i)=>{if(r.length!==headers.length)fail(`Quantidade de colunas divergente na linha de dados ${i+1}.`);return Object.fromEntries(headers.map((h,j)=>[h,r[j]]));})};
}
function dateBR(s) { const m=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());if(!m)fail('Data do CTN deve estar em DD/MM/AAAA.');return civil(`${m[3]}-${m[2]}-${m[1]}`); }
function readJSON(p) {return JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));}
function counts(registros) {
 const por_mes={},por_subtipo={};
 for(const r of registros){const m=r.data_lavratura.slice(0,7);por_mes[m]=(por_mes[m]||0)+1;const t=r.originais['Sub-tipo'].trim()||'Não informado';por_subtipo[t]=(por_subtipo[t]||0)+1;}
 return {total:registros.length,por_mes,por_subtipo,protocolo_ausente:registros.filter(r=>!r.protocolo).length};
}
function prepare(config, configDir=process.cwd()) {
 if(config?.versao!==1)fail('Configuração versao:1 obrigatória.');
 const routine=cutoff(config.corte_rotina), current=routine.dia.slice(0,7), prior=previousMonth(current);
 const inicio=civil(config.semana?.inicio), fim=civil(config.semana?.fim);
 if(new Date(inicio+'T00:00:00Z').getUTCDay()!==1||new Date(fim+'T00:00:00Z').getUTCDay()!==0||(Date.parse(fim)-Date.parse(inicio))/864e5!==6)fail('A semana civil deve abranger segunda a domingo, com limites explícitos.');
 if(routine.dia<inicio||routine.dia>fim||new Date(routine.dia+'T00:00:00Z').getUTCDay()!==5)fail('O corte programado da rotina deve ser a sexta-feira dentro da semana civil.');
 if(!['corrente_e_anterior','historico_integral'].includes(config.politica_historico))fail('Declare politica_historico: corrente_e_anterior ou historico_integral.');
 if(!Array.isArray(config.fontes)||!config.fontes.length)fail('Declare ao menos uma fonte CSV.');
 const snapshot=config.snapshot_meses ? (()=>{const file=path.resolve(configDir,config.snapshot_meses),bytes=fs.readFileSync(file),s=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));if(!Array.isArray(s.meses))fail('Snapshot deve ter o contrato GET /hub/atos-lavrados/meses: {meses:[...]}.');const months=new Map();for(const m of s.meses){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(m.mes)||!Number.isSafeInteger(m.revisao)||m.revisao<1||months.has(m.mes))fail('Snapshot contém mês/revisão inválidos.');months.set(m.mes,m.revisao);}return {arquivo:path.basename(file),sha256:sha(bytes),meses:months};})():null;
 const allMonths=new Map(),identities=new Set(),batches=[],sources=[];
 for(const source of config.fontes) {
  if(source.cobertura_mensal_confirmada!==true||source.familia!=='Escritura'||source.situacao!==4)fail('Confirme família Escritura, situação 4 e exportação mensal completa desde dia 1.');
  const cut=cutoff(source.corte_em),file=path.resolve(configDir,source.arquivo),bytes=fs.readFileSync(file);
  const decoded=decode(bytes,source.encoding),parsed=csv(decoded.text);
  if(!Array.isArray(source.meses)||!source.meses.length)fail('Declare os meses de cobertura de cada fonte.');
  const coverage=new Map();
  const meses=source.meses.map(m=>{
   if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(m.mes)||m.de!==m.mes+'-01')fail('Cada exportação precisa começar no dia 1 de cada mês; exportação apenas semanal não pode substituir o mês.');
   const ate=civil(m.ate);if(ate.slice(0,7)!==m.mes||ate>cut.dia)fail('Cobertura incompatível com mês/corte.');
   if(m.mes<cut.dia.slice(0,7)&&ate!==lastDay(m.mes))fail('Mês anterior ao corte precisa estar integralmente coberto até o último dia.');
   if(m.mes===cut.dia.slice(0,7)&&ate!==cut.dia)fail('Mês do corte deve conter dados desde dia 1 até o dia da extração.');
   if(!Number.isSafeInteger(m.revisao_base)||m.revisao_base<0)fail('revisao_base deve ser um inteiro explícito, nunca presumido.');
   if(snapshot&&(snapshot.meses.get(m.mes)||0)!==m.revisao_base)fail(`Revisão-base divergente do snapshot no mês ${m.mes}.`);
   if(allMonths.has(m.mes))fail(`Mês ${m.mes} dividido/repetido entre fontes. Unifique-o em uma única exportação completa.`);
   const result={mes:m.mes,ate,revisao_base:m.revisao_base,corte_em:cut.iso,dia_final_completo:ate<cut.dia};
   coverage.set(m.mes,result);allMonths.set(m.mes,result);return result;
  }).sort((a,b)=>a.mes.localeCompare(b.mes));
  const registros=parsed.rows.map((originais,i)=>{
   const line=i+2;
   if(originais.Acervo.trim()!=='Novo'||originais['Situação'].trim()!=='Registrado(a)')fail(`Linha ${line}: acervo/status incompatível; lote integral rejeitado, sem descarte.`);
   const dia=dateBR(originais.Data),month=coverage.get(dia.slice(0,7));if(!month||dia>month.ate)fail(`Linha ${line}: ato fora da cobertura declarada.`);
   const r={minuta:originais.Minuta.trim(),protocolo:originais.Protocolo.trim(),livro:originais.Livro.trim(),folha:originais.Folha.trim(),documento:originais.Documento.trim(),data_lavratura:dia,status:4,status_nome:'Registrado(a)',originais};
   if(!r.protocolo){if(originais.Protocolo!=='')fail(`Linha ${line}: protocolo contém apenas espaços; conferir a fonte antes de normalizar ausência.`);r.pendencia_identificacao=['protocolo_ausente_na_fonte'];}
   const identity=JSON.stringify([r.documento,r.minuta]);if(identities.has(identity))fail(`Linha ${line}: Documento+Minuta repetidos entre os dados da rotina.`);identities.add(identity);return r;
  }).sort((a,b)=>a.data_lavratura.localeCompare(b.data_lavratura)||a.minuta.localeCompare(b.minuta));
  if(!registros.length&&source.confirmar_mes_sem_atos!==true)fail('Fonte sem atos: confirmar_mes_sem_atos:true é obrigatório, pois o lote pode esvaziar o mês ativo.');
  const body={fonte:{sistema:'Extra Digital',arquivo:path.basename(file),sha256:sha(bytes)},meses,registros};
  const payload={operacao_id:uuid5('cn2o-extra-digital-import:'+sha(canonical(body))),...body};
  const valid=validarLote(payload);
  batches.push({payload,arquivo:`lote-extra-digital-${meses[0].mes}-a-${meses.at(-1).mes}-${payload.operacao_id}.json`,hash_canonico:valid.sha256});
  sources.push({arquivo:path.basename(file),sha256:sha(bytes),bytes:bytes.length,encoding:decoded.encoding,cabecalhos:parsed.headers,linhas:parsed.rows.length,originais_preservados_integralmente:true,...counts(registros)});
 }
 if(!allMonths.has(current)||!allMonths.has(prior))fail(`A rotina precisa atualizar pelo menos ${prior} e ${current}, ambos desde dia 1.`);
 const historical=snapshot?[...snapshot.meses.keys()].filter(m=>m<prior&&!allMonths.has(m)).sort():null;
 if(config.politica_historico==='historico_integral'&&!snapshot)fail('Revisão histórica integral exige snapshot dos meses ativos.');
 if(config.politica_historico==='historico_integral'&&historical.length)fail('Revisão histórica integral sem todos os meses ativos: '+historical.join(', '));
 const all=batches.flatMap(b=>b.payload.registros),week=all.filter(r=>r.data_lavratura>=inicio&&r.data_lavratura<=fim);
 const perWeekMonth=[];let d=inicio;
 while(d<=fim){const m=d.slice(0,7);if(!perWeekMonth.includes(m))perWeekMonth.push(m);const next=new Date(d+'T00:00:00Z');next.setUTCDate(next.getUTCDate()+1);d=next.toISOString().slice(0,10);}
 const complete=perWeekMonth.every(m=>{const c=allMonths.get(m),end=fim<lastDay(m)?fim:lastDay(m);return c&&c.ate>=end&&(c.ate>end||c.dia_final_completo);});
 const receipt={versao:1,estado:'PREPARADO_OFFLINE',importado_em_producao:false,corte_rotina:routine.iso,
  semana:{inicio,fim,criterio:'Extra Digital · Registrado(a) · data de lavratura',total_observado:week.length,total_oficial:complete?week.length:null,cobertura_completa:complete,por_subtipo:counts(week).por_subtipo,observacao:complete?'Semana civil coberta pela fonte; importação ainda não confirmada.':'Semana civil de segunda a domingo ainda parcial no corte disponível. Reconsultar para incluir atos tardios e fim de semana.'},
  totais:counts(all),fontes:sources,snapshot:snapshot?{arquivo:snapshot.arquivo,sha256:snapshot.sha256,meses_revisoes:Object.fromEntries(snapshot.meses)}:null,
  politica:{modo:config.politica_historico,meses_minimos:[prior,current],meses_atualizados:[...allMonths.keys()].sort(),meses_historicos_nao_revisados:historical,pendencias:[...(!snapshot?['Snapshot dos meses ativos ausente; revisões-base somente declaradas, não conferidas ao vivo.']:[]),...(historical?.length?['Meses históricos omitidos podem conter registros tardios, cancelamentos ou correções ainda não conciliados.']:[]),'Validar revisão atual no Hub e conferir recibos de importação antes de afirmar atualização.'],limite:'Atualizar corrente+anterior é mínimo operacional, não garantia contra alterações antigas. Correção de data entre meses exige reexportar integralmente origem e destino; cancelado sai da fotografia ativa sem apagar versões anteriores.'},
  lotes:batches.map(b=>({arquivo:b.arquivo,operacao_id:b.payload.operacao_id,sha256_canonico:b.hash_canonico,total:b.payload.registros.length,meses:b.payload.meses,estado:'VALIDADO_OFFLINE'})),
  privacidade:'Fontes e lotes contêm dados originais privados. Não incluir no Git, frontend ou assets públicos.'};
 const runId=uuid5('cn2o-extra-digital-week:'+sha(canonical(receipt)));
 return {batches,receipt:{operacao_preparacao:runId,...receipt},pasta:`semana-${inicio}-a-${fim}-${runId}`};
}
function writePrepared(prepared,outDir) {
 const output=path.resolve(outDir),rel=path.relative(REPO,output);
 if(!rel||(!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel)))fail('Saída privada deve ficar fora do repositório; não gravar dados de clientes no código.');
 const dir=path.join(output,prepared.pasta);
 const files=prepared.batches.map(b=>({name:b.arquivo,text:JSON.stringify(b.payload,null,2)+'\n'}));
 files.push({name:'estado-semanal.json',text:JSON.stringify(prepared.receipt,null,2)+'\n'});
 // Verificar todos antes de escrever; uma reexecução idêntica preserva bytes e arquivos.
 for(const f of files){const p=path.join(dir,f.name);if(fs.existsSync(p)&&fs.readFileSync(p,'utf8')!==f.text)fail('Arquivo de saída já existe com conteúdo diferente. Não sobrescrito.');}
 fs.mkdirSync(dir,{recursive:true});
 for(const f of files){const p=path.join(dir,f.name);if(!fs.existsSync(p))fs.writeFileSync(p,f.text,{encoding:'utf8',flag:'wx'});}
 return {diretorio:dir,recibo:path.join(dir,'estado-semanal.json'),operacao_preparacao:prepared.receipt.operacao_preparacao,estado:'PREPARADO_OFFLINE',registros:prepared.receipt.totais.total,semana:prepared.receipt.semana,meses:prepared.receipt.politica.meses_atualizados,lotes:prepared.receipt.lotes.map(l=>({arquivo:path.join(dir,l.arquivo),operacao_id:l.operacao_id,total:l.total})),pendencias:prepared.receipt.politica.pendencias};
}
if(require.main===module){
 try{
  const args=process.argv.slice(2),opts={};for(let i=0;i<args.length;i+=2){if(!['--config','--saida'].includes(args[i])||!args[i+1])fail('Uso: node scripts/preparar-lote-extra-digital.cjs --config CONFIG_PRIVADO.json --saida DIRETORIO_PRIVADO');opts[args[i]]=args[i+1];}
  if(!opts['--config']||!opts['--saida'])fail('Informe --config e --saida.');
  const configPath=path.resolve(opts['--config']);
  console.log(JSON.stringify(writePrepared(prepare(readJSON(configPath),path.dirname(configPath)),opts['--saida']),null,2));
 }catch(e){console.error(JSON.stringify({ok:false,erro:e.message,importado_em_producao:false}));process.exitCode=1;}
}
module.exports={prepare,writePrepared,decode,csv,civil,cutoff,canonical};
