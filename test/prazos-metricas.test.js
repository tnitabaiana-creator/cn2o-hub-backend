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

test('reconciliação setorial usa PostgreSQL e a evidência de entrega, preservando atos',async t=>{
  const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();
  t.after(()=>db.close());await db.exec(M.SCHEMA);
  const setor={...X,tipo:'setor',card_id:'setor-ficticio',chave:'setor:setor-ficticio:entrada-cadastro',
    protocolo:101,ato:'CV-Urbano',responsavel_login:'test.writer_a',
    inicio:'2026-10-14T14:00:00Z',vencimento:'2026-10-15T14:00:00Z',concluido_em:'2026-10-15T12:00:00Z',evidencia:'entrega-ficticia'};
  const corrigido={...setor,chave:'setor:setor-ficticio:entrada-digitalizacao',
    inicio:'2026-10-14T11:00:00Z',vencimento:'2026-10-14T20:00:00Z'};
  await t.test('recalcula a entrega legada na mesma chave e preserva metadados e a métrica do ato',async()=>{
    await M.registrar(db,setor);
    await M.registrar(db,{...setor,tipo:'ato',chave:'ato:setor-ficticio'});
    const antes=(await db.query('SELECT * FROM prazos_metricas ORDER BY chave')).rows;
    const antigo=antes.find(r=>r.tipo==='setor'),ato=antes.find(r=>r.tipo==='ato');
    const resultado=await M.registrarSetor(db,{...corrigido,protocolo:999,responsavel_login:'nao-substituir',ato:'nao-substituir'});
    assert.equal(resultado.chave,setor.chave);assert.equal(resultado.protocolo,101);
    assert.equal(resultado.responsavel_login,'test.writer_a');assert.equal(resultado.ato,'CV-Urbano');
    assert.deepEqual(resultado.registrado_em,antigo.registrado_em);
    assert.equal(new Date(resultado.inicio).toISOString(),'2026-10-14T11:00:00.000Z');
    assert.equal(new Date(resultado.concluido_em).toISOString(),'2026-10-15T12:00:00.000Z');
    assert.equal(resultado.no_prazo,false);assert.equal(Number(resultado.horas_uteis),9);assert.equal(Number(resultado.atraso_horas_uteis),1);
    await M.registrarSetor(db,corrigido);
    const depois=(await db.query('SELECT * FROM prazos_metricas ORDER BY chave')).rows;
    assert.equal(depois.length,2);assert.deepEqual(depois.find(r=>r.tipo==='ato'),ato);
    // A função genérica continua imutável para atos, inclusive em retentativas.
    await M.registrar(db,{...corrigido,tipo:'ato',chave:ato.chave});
    assert.deepEqual((await db.query('SELECT * FROM prazos_metricas WHERE chave=$1',[ato.chave])).rows[0],ato);
  });
  await t.test('novo evento usa chave por conclusão e retentativa com outro início não duplica',async()=>{
    const x={...corrigido,card_id:'outro-ficticio',evidencia:'entrega-nova'};
    const primeira=await M.registrarSetor(db,x);
    assert.equal(primeira.chave,'setor:outro-ficticio:conclusao:entrega-nova');
    const segunda=await M.registrarSetor(db,{...x,chave:'setor:chave-ignorada',inicio:'2026-10-14T12:00:00Z'});
    assert.equal(segunda.chave,primeira.chave);assert.equal(Number(segunda.horas_uteis),8);
    assert.equal((await db.query("SELECT * FROM prazos_metricas WHERE tipo='setor' AND card_id=$1",[x.card_id])).rows.length,1);
    await M.registrarSetor(db,{...x,evidencia:'outra-entrega'});
    assert.equal((await db.query("SELECT * FROM prazos_metricas WHERE tipo='setor' AND card_id=$1",[x.card_id])).rows.length,2);
  });
  await t.test('duplicidade preexistente é explícita e nenhuma linha é alterada ou apagada',async()=>{
    const x={...corrigido,card_id:'duplicado-ficticio',evidencia:'entrega-duplicada'};
    await M.registrar(db,{...x,chave:'legado-a'});await M.registrar(db,{...x,chave:'legado-b'});
    const antes=(await db.query('SELECT * FROM prazos_metricas WHERE card_id=$1 ORDER BY chave',[x.card_id])).rows;
    await assert.rejects(M.registrarSetor(db,{...x,inicio:'2026-10-14T12:00:00Z'}),/metrica_setor_conclusao_duplicada/);
    assert.deepEqual((await db.query('SELECT * FROM prazos_metricas WHERE card_id=$1 ORDER BY chave',[x.card_id])).rows,antes);
  });
  await t.test('a mesma ação não pode receber outra data de conclusão silenciosamente',async()=>{
    const antes=(await db.query('SELECT * FROM prazos_metricas WHERE chave=$1',[setor.chave])).rows[0];
    await assert.rejects(M.registrarSetor(db,{...corrigido,concluido_em:'2026-10-15T13:00:00Z'}),/metrica_setor_conclusao_divergente/);
    assert.deepEqual((await db.query('SELECT * FROM prazos_metricas WHERE chave=$1',[setor.chave])).rows[0],antes);
  });
  await t.test('colisão de chave não sobrescreve um ato ou uma identidade diferente',async()=>{
    const x={...corrigido,card_id:'colisao-ficticia',evidencia:'entrega-colisao'};
    const chave='setor:colisao-ficticia:conclusao:entrega-colisao';
    await M.registrar(db,{...X,chave,tipo:'ato'});
    const antes=(await db.query('SELECT * FROM prazos_metricas WHERE chave=$1',[chave])).rows[0];
    await assert.rejects(M.registrarSetor(db,x),/metrica_setor_chave_em_conflito/);
    assert.deepEqual((await db.query('SELECT * FROM prazos_metricas WHERE chave=$1',[chave])).rows[0],antes);
  });
  await t.test('rejeita tipo ato e identidade sem evidência antes de gravar',async()=>{
    const total=(await db.query('SELECT count(*)::int AS n FROM prazos_metricas')).rows[0].n;
    await assert.rejects(M.registrarSetor(db,X),/metrica_setor_identidade_invalida/);
    await assert.rejects(M.registrarSetor(db,{...corrigido,evidencia:' '}),/metrica_setor_identidade_invalida/);
    await assert.rejects(M.registrarSetor(db,{...corrigido,card_id:''}),/metrica_setor_identidade_invalida/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM prazos_metricas')).rows[0].n,total);
  });
});
