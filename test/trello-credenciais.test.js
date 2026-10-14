'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('consulta Trello normaliza quebra de linha nas credenciais sem alterar o caminho',async t=>{
  const originalFetch=global.fetch, key=process.env.TRELLO_KEY, token=process.env.TRELLO_TOKEN;
  t.after(()=>{global.fetch=originalFetch; if(key===undefined)delete process.env.TRELLO_KEY;else process.env.TRELLO_KEY=key;if(token===undefined)delete process.env.TRELLO_TOKEN;else process.env.TRELLO_TOKEN=token;});
  process.env.TRELLO_KEY=' chave-fixture\r\n';process.env.TRELLO_TOKEN=' token+fixture&x\n';
  global.fetch=async(url,opts)=>{
    const u=new URL(url);assert.equal(u.origin,'https://api.trello.com');assert.equal(u.pathname,'/1/boards/fixture/actions');assert.equal(u.searchParams.get('limit'),'1000');
    assert.equal(u.searchParams.get('key'),'chave-fixture');assert.equal(u.searchParams.get('token'),'token+fixture&x');assert.equal(opts.method,'GET');
    return {ok:true,json:async()=>[{id:'fixture'}]};
  };
  assert.deepEqual(await require('../trello').t('GET','/boards/fixture/actions?limit=1000'),[{id:'fixture'}]);
});
