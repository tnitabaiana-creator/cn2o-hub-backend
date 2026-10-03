import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
export function adapter(pool){return {sql:async(strings,...values)=>{
  const text=strings.reduce((out,part,i)=>out+(i?'$'+i:'')+part,'');
  return (await pool.query(text,values)).rows;
}};}
export function database(){return adapter(require('../db.js').pool);}
export function originalStore(pool){
  const address=key=>{const [id,part]=key.split('/');return [id,Number(part)];};
  return {
    async set(key,bytes,{metadata}){
      const result=await pool.query('INSERT INTO despesas_parts(document_id,part,digest,bytes) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING part',[...address(key),metadata.digest,Buffer.from(bytes)]);
      return {modified:result.rows.length>0};
    },
    async get(key){return (await pool.query('SELECT bytes FROM despesas_parts WHERE document_id=$1 AND part=$2',address(key))).rows[0]?.bytes??null;},
    async getMetadata(key){const row=(await pool.query('SELECT digest FROM despesas_parts WHERE document_id=$1 AND part=$2',address(key))).rows[0];return row?{metadata:{digest:row.digest}}:null;}
  };
}
