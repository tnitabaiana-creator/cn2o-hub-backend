'use strict';
// Casos inteiramente sintéticos; nenhum identificador corresponde a colaborador.
const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../prazos-metricas');
const X={chave:'ato:1',tipo:'ato',card_id:'1',inicio:'2026-10-14T12:00:00Z',vencimento:'2026-10-14T20:00:00Z',concluido_em:'2026-10-14T20:00:00Z',evidencia:'acao-final'};
test('conclusão no limite é pontual; atraso é medido no expediente real',()=>{
  const noPrazo=M.snapshot(X);assert.equal(noPrazo.no_prazo,true);assert.equal(noPrazo.atraso_horas_uteis,0);assert.equal(noPrazo.horas_uteis,7);
  const atraso=M.snapshot({...X,concluido_em:'2026-10-15T12:00:00Z'});assert.equal(atraso.no_prazo,false);assert.equal(atraso.atraso_horas_uteis,1);
});
test('não fabrica métricas sem evidência ou com cronologia invertida',()=>{
  assert.throws(()=>M.snapshot({...X,evidencia:null}),/evidencia/);
  assert.throws(()=>M.snapshot({...X,concluido_em:'2026-10-13T12:00:00Z'}),/evidencia/);
});
test('percentual usa conclusões comprovadas; agrupa por escrevente e tipo',()=>{
  const rows=[M.snapshot({...X,responsavel_login:'test.writer_a',ato:'CV-Urbano'}),M.snapshot({...X,concluido_em:'2026-10-15T12:00:00Z',responsavel_login:'test.writer_a',ato:'CV-Urbano'}),M.snapshot({...X,tipo:'setor'})];
  const r=M.resumir(rows);assert.equal(r.totais.ato.concluidos,2);assert.equal(r.totais.ato.percentual_no_prazo,50);assert.equal(r.totais.ato.atraso_medio_horas_uteis,1);
  assert.equal(r.totais.setor.percentual_no_prazo,100);assert.equal(r.por_responsavel_ato.length,2);
  assert.equal(M.resumir([]).totais.ato.percentual_no_prazo,null);
});
test('registro idempotente não altera a data de conclusão em uma retentativa',async()=>{
  let sql,args;await M.registrar({query:async(s,a)=>{sql=s;args=a;}},X);
  assert.match(sql,/ON CONFLICT\(chave\) DO NOTHING/);assert.equal(args[8],X.concluido_em.replace('Z','.000Z'));
});
test('período respeita fuso local e rejeita datas inválidas',async()=>{
  let args;const pool={query:async(_s,a)=>{args=a;return {rows:[]};}};
  const r=await M.consultar(pool,'2026-10-01','2026-10-31');assert.equal(args[0].toISOString(),'2026-10-01T03:00:00.000Z');assert.equal(args[1].toISOString(),'2026-11-01T03:00:00.000Z');assert.equal(r.totais.ato.percentual_no_prazo,null);
  await assert.rejects(M.consultar(pool,'2026-99-01','2026-10-31'),e=>e.status===400);
});
test('HTML e CSV têm estatística própria e neutralizam texto de fórmula',()=>{
  const r={...M.resumir([M.snapshot({...X,responsavel_login:'=cmd',ato:'TEST'})]),detalhes:[M.snapshot({...X,responsavel_login:'=cmd',ato:'TEST'})],criterio:'teste',cobertura:'sem completar lacunas'};
  assert.match(M.html(r),/Relógio do Ato/);assert.match(M.csv(r),/'=cmd/);assert.match(M.texto(r),/CONTROLE DE PRAZOS/);
});
