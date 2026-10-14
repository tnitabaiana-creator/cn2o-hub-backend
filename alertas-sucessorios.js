'use strict';
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJSON } = require('./protocolo-fonte');
const VERSION = '2026-10-14.1';
const LOCK = 83141014;
const CATEGORIAS = ['possivel_omissao_herdeiros','vinculo_a_conferir','divergencia_documental','indicios_a_apurar'];
const CHECKLIST = {
  identidade: 'Identidade do autor da herança e grafias conferidas com certidão de óbito e CPF.',
  documentos: 'Documentos do pedido confrontados com os documentos e fatos registrados no alerta.',
  pendencias: 'Pendências e pontos de atenção do alerta examinados e conclusão documentada.',
  orientacao: 'Orientação ou solução jurídica prévia da serventia considerada, quando fornecida.',
  encaminhamento: 'Resultado da conferência e fundamento da decisão registrados pelo tabelião.'
};
const erro = (status, codigo, message) => Object.assign(new Error(message), {status, codigo});
const hash = v => createHash('sha256').update(canonicalJSON(v)).digest('hex');
const normalizar = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function texto(v, limite, obrigatorio = true) {
  if (typeof v !== 'string' || v.length > limite || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v) || (obrigatorio && !v.trim())) throw erro(400,'CAMPO_INVALIDO','Informe um texto válido (até '+limite+' caracteres).');
  return v.trim();
}
function uuid(v) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v || '')) throw erro(400,'ID_INVALIDO','Identificador inválido.');
  return v;
}
function abrangido(ato) {
  const s = normalizar(ato);
  return /^(INV|CDH|SOB)(?:$| )/.test(s) || /INVENTAR|SOBREPARTILHA|CESSAO.*HEREDITAR/.test(s);
}
function sucessao(p) {
  if (!abrangido(p.ato)) return null;
  const s = p.sucessao;
  if (!s || !['simples','cumulativo','sobrepartilha','cessao'].includes(s.modalidade) || !Array.isArray(s.autores) || !s.autores.length || s.autores.length > 20) throw erro(400,'AUTORES_HERANCA_OBRIGATORIOS','Informe a modalidade e todos os autores da herança na etapa de controle sucessório.');
  const ehCDH = /CDH|CESSAO/.test(normalizar(p.ato));
  if (ehCDH !== (s.modalidade === 'cessao') || (s.modalidade === 'cumulativo' ? s.autores.length < 2 : s.autores.length !== 1)) throw erro(400,'MODALIDADE_INVALIDA','Confira a modalidade e a quantidade de autores da herança (cumulativo exige pelo menos dois).');
  const autores = s.autores.map(a => {
    const nome = texto(a?.nome, 180);
    if (normalizar(nome).split(' ').length < 2) throw erro(400,'NOME_INCOMPLETO','Informe o nome completo de cada autor da herança.');
    const cpf = String(a.cpf || '').replace(/\D/g,'');
    if (cpf && cpf.length !== 11) throw erro(400,'CPF_INVALIDO','CPF do autor da herança deve ter 11 dígitos ou ficar pendente.');
    return {nome, cpf};
  });
  if (new Set(autores.map(a=>normalizar(a.nome))).size !== autores.length) throw erro(400,'AUTOR_REPETIDO','Não repita o mesmo autor da herança.');
  return {modalidade:s.modalidade, autores};
}
function distancia(a,b) {
  let r = Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++) { const n=[i]; for(let j=1;j<=b.length;j++) n[j]=Math.min(n[j-1]+1,r[j]+1,r[j-1]+(a[i-1]===b[j-1]?0:1)); r=n; }
  return r[b.length];
}
function correspondencia(autor, alerta) {
  const nome = normalizar(autor.nome), nomes = [alerta.nome,...(alerta.variantes || [])].map(normalizar);
  if (autor.cpf && alerta.cpf && autor.cpf === alerta.cpf) return 'cpf';
  if (nomes.includes(nome)) return 'nome_ou_variante';
  const semParticulas = s=>s.split(' ').filter(x=>!['DE','DA','DO','DOS','DAS'].includes(x)).sort().join(' ');
  if (nomes.some(n=>semParticulas(n)===semParticulas(nome))) return 'nome_reordenado';
  if (nome.length >= 12 && nomes.some(n=>n.length>=12 && 1-distancia(nome,n)/Math.max(nome.length,n.length)>=0.86)) return 'nome_aproximado';
  return null;
}
function cadastro(b) {
  if (!CATEGORIAS.includes(b.categoria)) throw erro(400,'CATEGORIA_INVALIDA','Selecione o classificador do alerta.');
  if (!Array.isArray(b.variantes) || b.variantes.length>20 || !Array.isArray(b.documentado) || b.documentado.length>30 || !Array.isArray(b.pendencias) || b.pendencias.length>30) throw erro(400,'ALERTA_INVALIDO','Confira variantes, fatos documentados e pendências.');
  const cpf=String(b.cpf || '').replace(/\D/g,'');
  if (cpf && cpf.length!==11) throw erro(400,'CPF_INVALIDO','CPF deve ter 11 dígitos ou ficar vazio.');
  return {nome:texto(b.nome,180),cpf,variantes:b.variantes.map(v=>texto(v,180)),categoria:b.categoria,
    relato:texto(b.relato,12000),documentado:b.documentado.map(v=>texto(v,2000)),pendencias:b.pendencias.map(v=>texto(v,2000)),
    interessados:(Array.isArray(b.interessados)?b.interessados:[]).slice(0,40).map(v=>texto(v,400)),orientacao:texto(b.orientacao,6000),solucao_previa:texto(b.solucao_previa || '',12000,false),fonte_relato:texto(b.fonte_relato,500),data_recebimento:texto(b.data_recebimento,10)};
}
function fingerprint(p, matches) {
  const copia=JSON.parse(JSON.stringify(p));
  delete copia.controle_sucessorio; delete copia.escrevente;
  copia.curadoria=require('./protocolo-fonte').normalizarCuradoria(copia.curadoria,null,null);
  if(copia.curadoria){delete copia.curadoria.data;delete copia.curadoria.autor;}
  copia.sucessao=sucessao(p);
  return hash({payload:copia, alertas:matches.map(m=>({id:m.id,revisao:m.revisao})).sort((a,b)=>a.id.localeCompare(b.id))});
}
function createService(pool) {
  const transacao=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock($1)',[LOCK]);const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
  const evento=(c,id,acao,autor,dados)=>c.query('INSERT INTO sucessao_eventos(entidade,acao,autor,dados) VALUES($1,$2,$3,$4)',[id,acao,autor,dados]);
  async function init(){await pool.query(fs.readFileSync(path.join(__dirname,'migrations/20261014-alertas-sucessorios.sql'),'utf8'));}
  async function consultar(p,c=pool){
    const s=sucessao(p);if(!s)return {abrangido:false,correspondencias:[],fingerprint:null};
    const rows=(await c.query('SELECT id,dados,revisao FROM sucessao_alertas WHERE ativo ORDER BY id')).rows;
    const matches=rows.flatMap(row=>s.autores.map(a=>({autor:a.nome,tipo:correspondencia(a,row.dados)})).filter(x=>x.tipo).map(x=>({...x,id:row.id,revisao:row.revisao,dados:row.dados})));
    return {abrangido:true,correspondencias:matches,fingerprint:fingerprint(p,matches)};
  }
  async function salvar(b,usuario){const dados=cadastro(b);return transacao(async c=>{
    const id=b.id?uuid(b.id):randomUUID();
    if(b.id){const r=await c.query('UPDATE sucessao_alertas SET dados=$2,ativo=$3,revisao=revisao+1,atualizado_em=now() WHERE id=$1 AND revisao=$4 RETURNING id,revisao',[id,dados,b.ativo!==false,b.base_revisao]);if(!r.rows.length)throw erro(409,'ALERTA_ALTERADO','O alerta foi alterado; recarregue antes de salvar.');}
    else await c.query('INSERT INTO sucessao_alertas(id,dados,criado_por,ativo) VALUES($1,$2,$3,$4)',[id,dados,usuario.login,b.ativo!==false]);
    await evento(c,id,b.id?'alerta_atualizado':'alerta_criado',usuario.login,{dados,ativo:b.ativo!==false});
    return (await c.query('SELECT * FROM sucessao_alertas WHERE id=$1',[id])).rows[0];
  });}
  async function solicitar(p,usuario,observacao=''){return transacao(async c=>{
    if(Buffer.byteLength(JSON.stringify(p),'utf8')>256*1024)throw erro(413,'PEDIDO_GRANDE','O pedido excede o tamanho permitido para protocolo.');
    const resultado=await consultar(p,c);
    if(!resultado.correspondencias.length)throw erro(400,'SEM_CORRESPONDENCIA','Nenhum alerta corresponde a este pedido.');
    const anterior=(await c.query('SELECT * FROM sucessao_revisoes WHERE solicitante=$1 AND fingerprint=$2 AND protocolo IS NULL ORDER BY criado_em DESC LIMIT 1',[usuario.login,resultado.fingerprint])).rows[0];
    const vencida=anterior && ['conferido','liberado','homonimo'].includes(anterior.estado) && Date.now()-new Date(anterior.decidido_em).getTime()>7*86400000;
    if(anterior && !vencida)return anterior;
    const id=randomUUID();
    const r=await c.query('INSERT INTO sucessao_revisoes(id,fingerprint,solicitante,payload,correspondencias,conferencia) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[id,resultado.fingerprint,usuario.login,p,JSON.stringify(resultado.correspondencias),{observacao:texto(observacao,6000,false)}]);
    await evento(c,id,'analise_solicitada',usuario.login,{alertas:resultado.correspondencias.map(m=>m.id)});
    return r.rows[0];
  });}
  async function conferir(p,b,u){return transacao(async c=>{
    if(Buffer.byteLength(JSON.stringify(p),'utf8')>256*1024)throw erro(413,'PEDIDO_GRANDE','O pedido excede o tamanho permitido para protocolo.');
    if(!b || b.documentacao_completa!==true || b.interessados_contemplados!==true || b.sem_divergencia!==true)throw erro(400,'CONFERENCIA_PENDENTE','Confirme a conferência e a presença dos interessados do alerta na documentação.');
    const fundamento=texto(b.referencias,6000);
    if(fundamento.length<30)throw erro(400,'REFERENCIA_OBRIGATORIA','Indique os documentos e páginas que contemplam os pontos e interessados do alerta (mínimo de 30 caracteres).');
    const resultado=await consultar(p,c);
    if(!resultado.correspondencias.length)throw erro(400,'SEM_CORRESPONDENCIA','Nenhum alerta corresponde a este pedido.');
    const impedimento=(await c.query("SELECT id FROM sucessao_revisoes WHERE estado='obstado' AND EXISTS(SELECT 1 FROM jsonb_array_elements(correspondencias) m WHERE m->>'id'=ANY($1::text[])) LIMIT 1",[resultado.correspondencias.map(m=>m.id)])).rows[0];
    if(impedimento)throw erro(409,'DECISAO_TABELIAO_NECESSARIA','Há decisão de obstar relacionada a este alerta. Submeta ao tabelião antes de prosseguir.');
    const anterior=(await c.query('SELECT * FROM sucessao_revisoes WHERE solicitante=$1 AND fingerprint=$2 AND protocolo IS NULL ORDER BY criado_em DESC LIMIT 1',[u.login,resultado.fingerprint])).rows[0];
    if(anterior && ['pendente','obstado'].includes(anterior.estado))throw erro(409,'ANALISE_TABELIAO_PENDENTE','Este pedido já foi submetido ao tabelião. Aguarde a decisão.');
    if(anterior && Date.now()-new Date(anterior.decidido_em).getTime()<=7*86400000)return anterior;
    const id=randomUUID();
    const r=await c.query("INSERT INTO sucessao_revisoes(id,fingerprint,solicitante,payload,correspondencias,estado,conferencia,fundamento,decidido_por,decidido_em) VALUES($1,$2,$3,$4,$5,'conferido',$6,$7,$3,now()) RETURNING *",[id,resultado.fingerprint,u.login,p,JSON.stringify(resultado.correspondencias),b,fundamento]);
    await evento(c,id,'conferencia_escrevente',u.login,{referencias:fundamento,alertas:resultado.correspondencias.map(m=>m.id)});return r.rows[0];
  });}
  async function decidir(id,b,u){return transacao(async c=>{
    uuid(id);
    if(!['pendente','liberado','obstado','homonimo'].includes(b.estado))throw erro(400,'DECISAO_INVALIDA','Selecione uma decisão.');
    const fundamento=texto(b.fundamento,12000);
    if(fundamento.length<30)throw erro(400,'FUNDAMENTO_OBRIGATORIO','Registre fundamento documental com pelo menos 30 caracteres, incluindo documento/página/data.');
    if(b.estado==='liberado' && Object.keys(CHECKLIST).some(k=>b.checklist?.[k]!==true))throw erro(400,'CONFERENCIA_PENDENTE','Conclua todos os itens de conferência antes de liberar.');
    if(b.estado==='homonimo' && b.checklist?.identidade!==true)throw erro(400,'IDENTIDADE_PENDENTE','Confira documentalmente a identidade para afastar homonímia.');
    const atual=(await c.query('SELECT * FROM sucessao_revisoes WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!atual)throw erro(404,'REVISAO_NAO_ENCONTRADA','Análise não encontrada.');
    if(atual.protocolo)throw erro(409,'REVISAO_UTILIZADA','Esta decisão já foi utilizada em um protocolo.');
    if(atual.estado!==b.base_estado)throw erro(409,'DECISAO_ALTERADA','A decisão mudou; recarregue a análise.');
    if((atual.decidido_em?new Date(atual.decidido_em).toISOString():null)!==(b.base_decidido_em || null))throw erro(409,'DECISAO_ALTERADA','A decisão mudou; recarregue a análise.');
    if((await consultar(atual.payload,c)).fingerprint!==atual.fingerprint)throw erro(409,'ALERTA_ALTERADO','O cadastro de alertas mudou; solicite nova análise do pedido.');
    const r=await c.query('UPDATE sucessao_revisoes SET estado=$2,conferencia=conferencia || $3::jsonb,fundamento=$4,decidido_por=$5,decidido_em=now() WHERE id=$1 RETURNING *',[id,b.estado,JSON.stringify({checklist:b.checklist || {}}),fundamento,u.login]);
    await evento(c,id,'decisao_'+b.estado,u.login,{fundamento,checklist:b.checklist || {}});return r.rows[0];
  });}
  async function validar(c,p,u){
    delete p.controle_sucessorio; // nunca aceita decisão declarada no cliente
    if(!abrangido(p.ato))return;
    await c.query('SELECT pg_advisory_xact_lock($1)',[LOCK]);
    const r=await consultar(p,c);p.sucessao=sucessao(p);
    if(!r.correspondencias.length)return;
    const rev=(await c.query("SELECT * FROM sucessao_revisoes WHERE fingerprint=$1 AND solicitante=$2 AND protocolo IS NULL ORDER BY criado_em DESC LIMIT 1 FOR UPDATE",[r.fingerprint,u])).rows[0];
    if(rev?.estado==='conferido' && (await c.query("SELECT id FROM sucessao_revisoes WHERE estado='obstado' AND EXISTS(SELECT 1 FROM jsonb_array_elements(correspondencias) m WHERE m->>'id'=ANY($1::text[])) LIMIT 1",[r.correspondencias.map(m=>m.id)])).rows.length)throw erro(409,'DECISAO_TABELIAO_NECESSARIA','Há decisão de obstar relacionada a este alerta. Aguarde análise do tabelião.');
    if(!rev || !['conferido','liberado','homonimo'].includes(rev.estado) || Date.now()-new Date(rev.decidido_em).getTime()>7*86400000)throw erro(409,'CONTROLE_SUCESSORIO_PENDENTE','Alerta sucessório: registre a conferência documental ou submeta a pendência ao tabelião antes de protocolar e gerar boleto. Abra a etapa de controle sucessório.');
    p.controle_sucessorio={revisao_id:rev.id,estado:rev.estado,decidido_por:rev.decidido_por,decidido_em:rev.decidido_em};
  }
  async function consumir(c,p,numero,u){if(p.controle_sucessorio){const id=p.controle_sucessorio.revisao_id;await c.query('UPDATE sucessao_revisoes SET protocolo=$2 WHERE id=$1',[id,numero]);await evento(c,id,'protocolo_autorizado',u,{numero});}}
  async function anexar(id,b,u){
    uuid(id);const nome=texto(b.nome,180).replace(/[\\/\r\n"]/g,'_');
    if(typeof b.base64!=='string'||b.base64.length>12*1024*1024||!b.base64.length||b.base64.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(b.base64))throw erro(400,'PDF_INVALIDO','Anexe um PDF de até 8 MB.');
    const arquivo=Buffer.from(b.base64,'base64');if(arquivo.length>8*1024*1024||arquivo.subarray(0,5).toString()!=='%PDF-')throw erro(400,'PDF_INVALIDO','Anexe um PDF de até 8 MB.');
    const sha=createHash('sha256').update(arquivo).digest('hex');
    return transacao(async c=>{
      if(!(await c.query('SELECT id FROM sucessao_alertas WHERE id=$1',[id])).rows.length)throw erro(404,'ALERTA_NAO_ENCONTRADO','Alerta não encontrado.');
      const antigo=(await c.query('SELECT id,nome,sha256 FROM sucessao_documentos WHERE alerta_id=$1 AND sha256=$2',[id,sha])).rows[0];if(antigo)return antigo;
      const doc=randomUUID();await c.query('INSERT INTO sucessao_documentos(id,alerta_id,nome,sha256,arquivo,criado_por) VALUES($1,$2,$3,$4,$5,$6)',[doc,id,nome,sha,arquivo,u.login]);
      await c.query('UPDATE sucessao_alertas SET revisao=revisao+1,atualizado_em=now() WHERE id=$1',[id]);
      await evento(c,id,'documento_anexado',u.login,{documento_id:doc,nome,sha256:sha});return {id:doc,nome,sha256:sha};
    });
  }
  return {init,consultar,salvar,solicitar,conferir,decidir,validar,consumir,anexar};
}
function createRouter({pool,exigeSessao,ehAdmin,service=createService(pool)}){
  const express=require('express'), r=express.Router();
  r.use(exigeSessao);r.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});r.use(express.json({limit:'13mb'}));
  const admin=(req,res,next)=>ehAdmin(req.usuario)?next():res.status(403).json({erro:'Somente o tabelião pode cadastrar alertas e decidir a análise.'});
  const rota=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){if(!e.status)console.error('controle sucessório:',e.codigo || 'falha');res.status(e.status || 503).json({erro:e.status?e.message:'Controle sucessório indisponível. Aguarde a regularização antes de protocolar.',motivo:e.codigo || 'CONTROLE_INDISPONIVEL'});}};
  r.get('/status',rota(async(_req,res)=>{await pool.query('SELECT 1 FROM sucessao_alertas LIMIT 1');res.json({versao:VERSION,checklist:CHECKLIST,categorias:CATEGORIAS});}));
  r.post('/consultar',rota(async(req,res)=>res.json(await service.consultar(req.body))));
  r.get('/alertas',admin,rota(async(_req,res)=>res.json((await pool.query('SELECT * FROM sucessao_alertas ORDER BY atualizado_em DESC')).rows)));
  r.post('/alertas',admin,rota(async(req,res)=>res.json(await service.salvar(req.body,req.usuario))));
  r.post('/alertas/:id/documentos',admin,rota(async(req,res)=>res.json(await service.anexar(req.params.id,req.body,req.usuario))));
  r.get('/alertas/:id/documentos',rota(async(req,res)=>{uuid(req.params.id);res.json((await pool.query('SELECT id,nome,sha256,criado_em FROM sucessao_documentos WHERE alerta_id=$1',[req.params.id])).rows);}));
  r.get('/documentos/:id',rota(async(req,res)=>{uuid(req.params.id);const d=(await pool.query('SELECT nome,arquivo FROM sucessao_documentos WHERE id=$1',[req.params.id])).rows[0];if(!d)throw erro(404,'DOCUMENTO_NAO_ENCONTRADO','Documento não encontrado.');res.type('application/pdf').set('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(d.nome)).send(d.arquivo);}));
  r.post('/revisoes',rota(async(req,res)=>res.json(await service.solicitar(req.body.payload,req.usuario,req.body.observacao || ''))));
  r.post('/conferir',rota(async(req,res)=>res.json(await service.conferir(req.body.payload,req.body.conferencia,req.usuario))));
  r.get('/revisoes',rota(async(req,res)=>{const adminUser=ehAdmin(req.usuario);res.json((await pool.query('SELECT id,fingerprint,solicitante,estado,payload->\'sucessao\' AS sucessao,criado_em,protocolo FROM sucessao_revisoes WHERE ($1 OR solicitante=$2) ORDER BY criado_em DESC LIMIT 200',[adminUser,req.usuario.login])).rows);}));
  r.get('/revisoes/:id',rota(async(req,res)=>{uuid(req.params.id);const a=(await pool.query('SELECT * FROM sucessao_revisoes WHERE id=$1 AND ($2 OR solicitante=$3)',[req.params.id,ehAdmin(req.usuario),req.usuario.login])).rows[0];if(!a)throw erro(404,'REVISAO_NAO_ENCONTRADA','Análise não encontrada.');res.json(a);}));
  r.post('/revisoes/:id/decidir',admin,rota(async(req,res)=>res.json(await service.decidir(req.params.id,req.body,req.usuario))));
  r.get('/historico/:id',admin,rota(async(req,res)=>{uuid(req.params.id);res.json((await pool.query('SELECT acao,autor,dados,em FROM sucessao_eventos WHERE entidade=$1 ORDER BY id',[req.params.id])).rows);}));
  return r;
}
module.exports={VERSION,CHECKLIST,CATEGORIAS,normalizar,abrangido,sucessao,correspondencia,cadastro,fingerprint,createService,createRouter,erro};
