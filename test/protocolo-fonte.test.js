'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const f = require('../protocolo-fonte');
const ia = require('../protocolo-fonte-ia');
const integracao = require('../protocolo-fonte-integracao');
const fixture = require('./fixtures/protocolo-fonte-v1.json');
const clone = v => JSON.parse(JSON.stringify(v));
const base = () => clone(fixture.row);
const cur = { estado: 'compativeis', confirmado: true };
test('contrato compartilhado e hash conhecido: acentos, fonte e Trello', () => {
  const fonte = f.criarFonte(base());
  assert.equal(fonte.revisao.sha256, '441907e2cf4b7a6a6aa0cd964fc1e3ac70fd9187f093f90d6ebd39db788ebda7');
  assert.deepEqual(fonte, fixture.fonte);
  assert.equal(f.blocosTrello(fonte), fixture.trello);
});
test('ordem de chaves não muda revisão; fato alterado muda', () => {
  assert.equal(f.hash({ b: 2, a: [1, { z: false, a: 'á' }] }), f.hash({ a: [1, { a: 'á', z: false }], b: 2 }));
  const row = base(), antigo = f.criarFonte(row);
  row.dados.preco = '200.000,00';
  assert.notEqual(f.criarFonte(row).revisao.sha256, antigo.revisao.sha256);
});
test('número e ato vinculam hash; card posterior não altera revisão', () => {
  const row = base(), fonte = f.criarFonte(row);
  row.card_id = 'outro'; assert.equal(f.criarFonte(row).revisao.sha256, fonte.revisao.sha256);
  row.numero++; assert.notEqual(f.criarFonte(row).revisao.sha256, fonte.revisao.sha256);
});
test('legados têm curadoria pendente, nunca inventada conferência', () => {
  const row = base(); delete row.dados.curadoria;
  const fonte = f.criarFonte(row);
  assert.equal(fonte.curadoria.estado, 'nao_conferidos');
  assert.equal(fonte.curadoria.confirmado, false);
  assert.equal(fonte.curadoria.autor, null);
});
test('metadados de autoria não podem ser escolhidos pelo cliente', () => {
  const dados = f.prepararDados({ ato: 'PROC', numero: 1, curadoria: { ...cur, autor: 'forjado', data: '2000-01-01' } }, { login: 'sessao' }, '2026-10-06T15:00:00Z');
  assert.equal(dados.curadoria.autor, 'sessao'); assert.equal(dados.curadoria.data, '2026-10-06T15:00:00.000Z'); assert.equal(dados.numero, undefined);
});
test('todos atos preservam campos desconhecidos, booleanos, nulos e listas', () => {
  for (const ato of ['CV-Urbano','CV-Rural','CDH','CDP','DOA','INV','TEST','PER','DIV','UE','DUE','RERRAT','ATA-U','ATA-W/A','PROC','CERT','LAJE','DAC']) {
    const row = base(); row.dados = { ato, nova_chave: { 'a/b': false, 'x~y': null, lista: ['ação', 3] } };
    const fonte = f.criarFonte(row);
    assert.equal(fonte.campos.find(c => c.id === '/dados/nova_chave/a~1b').valor, false);
    assert.equal(fonte.campos.find(c => c.id === '/dados/nova_chave/x~0y').valor, null);
    assert.equal(fonte.dados.nova_chave.lista[0], 'ação');
  }
});
test('revisão otimista e compatibilidade do ato recusam troca', () => {
  const fonte = f.criarFonte(base());
  assert.throws(() => f.validarRevisao(fonte, '0'.repeat(64)), /mudou/);
  assert.throws(() => f.validarAto(fonte, 'PROC'), /tipo de ato/);
  f.validarAto({ protocolo: { ato: 'DUE' } }, 'DISS_UE');
});
test('agentes multiato aceitam suas variantes sem confundir tipos jurídicos ou relaxar o Hub',()=>{
  const fonte=ato=>({protocolo:{ato}});
  for(const ato of ['CV-Urbano','CV-Rural']) f.validarAtoAgente(fonte(ato),{slug:'compra-venda',codigo_ato:'CV-Urbano'});
  for(const ato of ['ATA-W','ATA-W/A']) f.validarAtoAgente(fonte(ato),{slug:'ata-digital',codigo_ato:'ATA-W'});
  assert.throws(()=>f.validarAtoAgente(fonte('DUE'),{slug:'uniao-estavel',codigo_ato:'UE'}),/tipo de ato/);
  assert.throws(()=>f.validarAtoAgente(fonte('CDH'),{slug:'compra-venda',codigo_ato:'CV-Urbano'}),/tipo de ato/);
  assert.throws(()=>f.validarAto(fonte('CV-Rural'),'CV-Urbano'),/tipo de ato/);
});
const manifesto = () => [{ id: 'documento-1', nome: 'comprovante-ficticio.pdf', sha256: 'a'.repeat(64), paginas_texto: [{ pagina: 2, texto: 'Transferência realizada de R$ 100.000,00 em 05/10/2026 para o negócio descrito.', incertas: [] }] }];
const decisao = () => ({ campo: '/dados/triagem/pag_ant_forma', contradicao: true, valor_documento: 'transferencia', mesmo_fato: true, legivel: true,
  documento: { id: 'documento-1', sha256: 'a'.repeat(64), pagina: 2, trecho: 'Transferência realizada de R$ 100.000,00 em 05/10/2026' },
  motivo: 'Comprovante legível do mesmo negócio e mesma parcela.', cobertura: 'aplicado', trecho_minuta: 'O pagamento foi por transferência.' });
const matrizCampo = (d, m = manifesto()) => f.matrizCobertura(f.criarFonte(base()), [d], m, 'O pagamento foi por transferência.').find(c => c.campo === d.campo);
test('espécie versus comprovante legível do mesmo fato: documento e valores preservados', () => {
  const c = matrizCampo(decisao());
  assert.equal(c.decisao, 'documento'); assert.equal(c.valor_protocolo, 'espécie'); assert.equal(c.valor_adotado, 'transferencia');
  assert.equal(c.cobertura, 'aplicado'); assert.equal(c.revisao_humana, true);
});
test('sem contradição prevalece protocolo', () => {
  const d = decisao(); d.contradicao = false;
  const c = matrizCampo(d); assert.equal(c.decisao, 'protocolo'); assert.equal(c.valor_adotado, 'espécie');
});
test('campo originalmente vazio admite complemento documental comprovado sem inventar conflito',()=>{
  const row=base();row.dados.triagem.pag_ant_forma='';const fonte=f.criarFonte(row);
  const d=decisao();d.contradicao=false;d.motivo='Forma ausente do protocolo, comprovada no documento do mesmo negócio.';
  const c=f.matrizCobertura(fonte,[d],manifesto(),'O pagamento foi por transferência.').find(c=>c.campo===d.campo);
  assert.equal(c.decisao,'documento');assert.equal(c.valor_protocolo,'');assert.equal(c.valor_adotado,'transferencia');assert.equal(c.cobertura,'aplicado');
  const semProva=f.matrizCobertura(fonte,[d],[],'O pagamento foi por transferência.').find(c=>c.campo===d.campo);
  assert.equal(semProva.decisao,'pendente');assert.equal(semProva.cobertura,'pendente');assert.equal(semProva.valor_adotado,'');
});
test('documento alheio, ilegível, página errada, falso hash e falsa citação nunca sobrepõem', () => {
  for (const alterar of [d => d.mesmo_fato=false, d => d.legivel=false, d => d.documento.pagina=7, d => d.documento.sha256='b'.repeat(64), d => d.documento.trecho='Citação que não existe na página do comprovante']) {
    const d = decisao(); alterar(d); const c = matrizCampo(d);
    assert.equal(c.decisao, 'pendente'); assert.equal(c.valor_adotado, 'espécie'); assert.equal(c.cobertura, 'pendente');
  }
});
test('sem OCR ou palavra incerta: não valida por declaração da IA', () => {
  assert.equal(matrizCampo(decisao(), [{ ...manifesto()[0], paginas_texto: [] }]).decisao, 'pendente');
  const m=manifesto();m[0].paginas_texto[0].incertas=[{ palavra:'100.000,00',conf:0.4 }];
  assert.equal(matrizCampo(decisao(),m).decisao, 'pendente');
});
test('aplicado precisa de trecho na minuta; campos ausentes geram cobertura pendente', () => {
  const d=decisao();d.trecho_minuta='Texto inventado'; assert.equal(matrizCampo(d).cobertura,'pendente');
  const fonte=f.criarFonte(base()), m=f.matrizCobertura(fonte,[],[], 'minuta');
  assert.equal(m.length,fonte.campos.length);assert.ok(m.every(c=>c.cobertura==='pendente'));
});
test('citação verdadeira não comprova outro valor nem cobertura genérica de pagamento',()=>{
  const d=decisao();d.valor_documento='cheque';assert.equal(matrizCampo(d).decisao,'pendente');
  const semValor=decisao();semValor.trecho_minuta='SAIBAM';
  const fonte=f.criarFonte(base());
  assert.equal(f.matrizCobertura(fonte,[semValor],manifesto(),'SAIBAM').find(c=>c.campo===d.campo).cobertura,'pendente');
  const nao=decisao();nao.cobertura='nao_aplicavel';assert.equal(matrizCampo(nao).cobertura,'pendente');
});
test('valores em centavos e reais são comparados sem adotar cifra diferente',()=>{
  const fonte=f.criarFonte(base()), campo='/dados/pagamentos/0/valor_centavos';
  const d={...decisao(),campo,valor_documento:10000000,trecho_minuta:'Valor de R$ 100.000,00.'};
  const m=f.matrizCobertura(fonte,[d],manifesto(),'Valor de R$ 100.000,00.').find(c=>c.campo===campo);
  assert.equal(m.decisao,'documento');assert.equal(m.cobertura,'aplicado');
  d.valor_documento=99900000;assert.equal(f.matrizCobertura(fonte,[d],manifesto(),'Valor de R$ 100.000,00.').find(c=>c.campo===campo).decisao,'pendente');
});
test('TEST não publica vontade, curadoria, qualificação ou observações', () => {
  const row=base();row.dados.ato='TEST';row.dados.qualificacao='SEGREDO_A';row.dados.manifestacao_vontade='SEGREDO_B';
  const desc=f.atualizarDescricao('Texto anterior SEGREDO_C',f.criarFonte(row));
  assert.ok(!desc.includes('SEGREDO'));assert.ok(!desc.includes('<!--DADOS'));assert.match(desc,/"projecao":"restrita"/);
});
test('transporte não duplica dados e marcadores em conteúdo não quebram bloco', () => {
  const row=base();row.dados.observacoes='texto DADOS--> <!--DADOS e CN2O_FONTE-->';
  const desc=f.blocosTrello(f.criarFonte(row));
  assert.equal((desc.match(/<!--DADOS/g)||[]).length,1);
  const payload=JSON.parse(/<!--DADOS\n([\s\S]*?)\nDADOS-->/.exec(desc)[1]);assert.equal(payload.observacoes,row.dados.observacoes);
});
test('limite Trello falha sem truncar dados', () => {
  const row=base();row.dados.observacoes='x'.repeat(16001);
  assert.throws(()=>f.atualizarDescricao('',f.criarFonte(row)),/limite/);
});
test('pagamento admite data válida, não negativo, não decimal-centavos ou calendário inexistente', () => {
  for(const p of [{valor_centavos:-1},{valor_centavos:1.2},{valor_centavos:100,data:'2026-02-30'}]) assert.throws(()=>f.normalizarPagamentos([{forma:'pix',status:'realizado',...p}]));
});
test('parcelas incompatíveis com triagem não podem declarar compatibilidade', () => {
  assert.throws(()=>f.prepararDados({ato:'CV-Urbano',triagem:{preco:'100,00',pag_momento:'Já pago integralmente',pag_ant_forma:'Em espécie'},pagamentos:[{valor_centavos:10000,forma:'pix',status:'realizado'}],curadoria:cur},{login:'sessao'}),/oposição/);
});
test('JSON de saída exige texto e matriz fora da escritura', () => {
  assert.throws(()=>ia.lerResultado('Texto sem matriz'),/conferência/);
  assert.equal(ia.lerResultado('{"texto":"Escritura","decisoes":[]}').texto,'Escritura');
});
test('fonte omitida não permite PRONTA; aviso fica fora do instrumento',()=>{
  const texto='Estado: PRONTA\n===MINUTA_COPIAVEL===\nEscritura fictícia.\n===FIM_MINUTA===';
  const r=ia.conferirResultado(f.criarFonte(base()),{texto:JSON.stringify({texto,decisoes:[]})},[]);
  assert.match(r.texto,/Estado: PRELIMINAR/);assert.match(r.texto,/===MINUTA_COPIAVEL===\nEscritura fictícia.\n===FIM_MINUTA===/);
});
test('token serviço dedicado: fail closed ausente, inválido, query não autentica', () => {
  assert.equal(integracao.autorizado('Bearer '+'a'.repeat(64),undefined),false);
  assert.equal(integracao.autorizado('Bearer '+'a'.repeat(64),'b'.repeat(64)),false);
  assert.equal(integracao.autorizado('Bearer '+'a'.repeat(64),'a'.repeat(64)),true);
});
async function lerIntegracao(rows, token='a'.repeat(64), cardId='c'.repeat(24)) {
  let acessos=0;const res={statusCode:200,set(){},status(s){this.statusCode=s;return this;},json(body){this.body=body;return this;}};
  await integracao.handler({query:async()=>{acessos++;return {rows};},segredo:()=> 'a'.repeat(64)})({headers:{authorization:'Bearer '+token},params:{cardId}},res);
  return {...res,acessos};
}
test('endpoint privado retorna TEST somente autenticado e falha em inexistente/duplicado',async()=>{
  const row=base();row.dados.ato='TEST';row.card_id='c'.repeat(24);
  const ok=await lerIntegracao([row]);assert.equal(ok.statusCode,200);assert.equal(ok.body.fonte.protocolo.ato,'TEST');
  const negado=await lerIntegracao([row],'b'.repeat(64));assert.equal(negado.statusCode,401);assert.equal(negado.acessos,0);
  assert.equal((await lerIntegracao([])).statusCode,404);assert.equal((await lerIntegracao([row,row])).statusCode,409);
  assert.equal((await lerIntegracao([row],'a'.repeat(64),'../../dados')).statusCode,400);
});
test('JavaScript dos geradores continua sintaticamente válido, inclusive UI',()=>{
  for(const n of ['agentes.js','db-agentes.js','gemini.js','hub.js','ocr.js','server.js']) new vm.Script(fs.readFileSync(path.join(__dirname,'..',n),'utf8'),{filename:n});
  const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
  for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]);
});
