'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {abrangido,sucessao,correspondencia,fingerprint,cadastro}=require('../alertas-sucessorios');
const alerta={nome:'Pessoa Exemplo Silva',variantes:['Pessoa Exemplo Lima']};
test('abrange simples, cumulativo, sobrepartilha e CDH; não abrange compra e venda',()=>{
 for(const a of ['INV','Inventário simples','Inventário cumulativo','SOB','Escritura de Sobrepartilha','CDH','Cessão de Direitos Hereditários'])assert.equal(abrangido(a),true,a);
 for(const a of ['CV-Urbano','CDP','TEST','DIV'])assert.equal(abrangido(a),false,a);
});
test('identificação de todos os autores é obrigatória e não pode ser omitida no cumulativo',()=>{
 assert.throws(()=>sucessao({ato:'INV'}),/todos os autores/);
 assert.throws(()=>sucessao({ato:'INV',sucessao:{modalidade:'cumulativo',autores:[{nome:'Pessoa Exemplo'}]}}),/pelo menos dois/);
 assert.equal(sucessao({ato:'CDH',sucessao:{modalidade:'cessao',autores:[{nome:'Pessoa Exemplo'}]}}).autores.length,1);
});
test('corresponde a acentos, variantes, ordem e pequenos erros sem afirmar identidade',()=>{
 assert.equal(correspondencia({nome:'Pessóa Exemplo Silva'},alerta),'nome_ou_variante');
 assert.equal(correspondencia({nome:'Pessoa Exemplo Lima'},alerta),'nome_ou_variante');
 assert.equal(correspondencia({nome:'Silva Pessoa Exemplo'},alerta),'nome_reordenado');
 assert.equal(correspondencia({nome:'Pessoa Exemploo Silva'},alerta),'nome_aproximado');
 assert.equal(correspondencia({nome:'Terceiro Sem Relação'},alerta),null);
 assert.equal(correspondencia({nome:'Pessoa Exemplo Silva',cpf:'11111111111'},{...alerta,cpf:'22222222222'}),'nome_ou_variante');
});
test('nome parcial reconhece omissão de sobrenome, acentos, partículas e ordem',()=>{
 const a={nome:'Mariana Alves Pereira',variantes:[]};
 for(const nome of ['mariana alves','Mariána Álves','MARIANA  ALVES','Mariana de Alves','Alves Mariana'])assert.equal(correspondencia({nome},a),'nome_parcial',nome);
});
test('nome parcial tolera letras omitidas, repetidas, trocadas e abreviações',()=>{
 const a={nome:'Mariana Alves Pereira',variantes:[]};
 for(const nome of ['marina alves','marianna alves','mairana alves','mariana alvez','Marian Alves','M. Alves Pereira'])assert.ok(correspondencia({nome},a),nome);
});
test('aproximação não reutiliza palavras nem corresponde apenas por sobrenomes ou iniciais',()=>{
 const a={nome:'Mariana Alves Pereira',variantes:[]};
 for(const nome of ['Alves Pereira','Mariana Mariana','Mariana Santos','Carlos Santos Oliveira','M Alves','M A P'])assert.equal(correspondencia({nome},a),null,nome);
});
test('decisão vincula pedido e revisão do alerta, ignora identidade e data geradas no servidor',()=>{
 const p={ato:'INV',sucessao:{modalidade:'simples',autores:[{nome:'Pessoa Exemplo Silva'}]},curadoria:{estado:'compativeis',confirmado:true}};
 const m=[{id:'a',revisao:1}],h=fingerprint(p,m);
 assert.equal(fingerprint({...p,escrevente:'Servidor',curadoria:{...p.curadoria,autor:'a',data:'2026-10-14'}},m),h);
 assert.notEqual(fingerprint({...p,observacoes_nao_documentadas:'Mudança'},m),h);
 assert.notEqual(fingerprint(p,[{id:'a',revisao:2}]),h);
});
test('cadastro preserva orientação jurídica fornecida sem exigir solução do modelo',()=>{
 const a=cadastro({nome:'Pessoa Exemplo',variantes:[],categoria:'vinculo_a_conferir',relato:'Informação recebida para apuração.',documentado:['Documento apresentado, página 1.'],pendencias:['Conferir identidade.'],orientacao:'Submeter à conferência.',fonte_relato:'Tabelião',data_recebimento:'2026-10-14'});
 assert.equal(a.solucao_previa,'');assert.equal(a.categoria,'vinculo_a_conferir');
});
