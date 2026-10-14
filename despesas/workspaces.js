'use strict';

// Namespaces are fixed by the server route, never by an uploaded document.
// Separate tables also keep the existing CN2O consumers and exports isolated.
const PROFILES = Object.freeze({
  cn2o: Object.freeze({ id: 'cn2o', name: 'Cartório CN2O', route: 'despesas', prefix: '' }),
  bravo: Object.freeze({ id: 'bravo', name: 'Bravo Patrimonial', route: 'despesas-bravo', prefix: 'bravo_' })
});
function profile(id = 'cn2o') {
  if (!Object.hasOwn(PROFILES, id)) throw new Error('Controle de despesas inválido.');
  return PROFILES[id];
}
function scopedSQL(text, id) {
  const p = profile(id);
  if (!p.prefix) return text;
  return text.replace(/\bdespesas_[a-z_]+\b/g, name => p.prefix + name);
}
function scopedPool(pool, id = 'cn2o') {
  profile(id);
  if (id === 'cn2o') return pool;
  const query = target => (...args) => {
    const [input, ...rest] = args;
    return target.query(typeof input === 'string' ? scopedSQL(input, id) : { ...input, text: scopedSQL(input.text, id) }, ...rest);
  };
  return {
    query: query(pool),
    async connect() {
      const client = await pool.connect();
      return { query: query(client), release: (...args) => client.release(...args) };
    }
  };
}
module.exports = { PROFILES, profile, scopedSQL, scopedPool };
