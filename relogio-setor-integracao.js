'use strict';

// A mesma projeção dos relatórios, com recuperação REST independente do webhook.
// Eventos recuperados têm origem setorial: não reprocessam as métricas legadas.
const db = require('./db');
const rastreio = require('./rastreio');
const relogio = require('./relogio-setor');
const crypto = require('node:crypto');

function criarColetor({ api = relogio.criarApi(), pool = db.pool,
  registrar = rastreio.registrarEventos, agora = () => new Date() } = {}) {
  let pronto = false;
  async function coletar(path, since = null) {
    const alvo = /^\/(cards|boards)\/([a-f0-9]{24})\/actions$/.exec(path);
    if (!alvo || (alvo[1] === 'boards' && !relogio.QUADROS.includes(alvo[2]))) {
      throw Object.assign(Error('historico_recurso_invalido'), { codigo: 'historico_recurso_invalido' });
    }
    const acoes = [], vistos = new Map();
    let before = null, completo = false;
    for (let i = 0; i < 20; i++) {
      const params = new URLSearchParams({ filter: rastreio.FILTRO_API, limit: '1000' });
      if (since) params.set('since', since);
      if (before) params.set('before', before);
      const pagina = await api('GET', path + '?' + params);
      if (!Array.isArray(pagina)) throw Object.assign(Error('historico_resposta_invalida'), { codigo: 'historico_resposta_invalida' });
      for (const a of pagina) {
        if (!/^[a-f0-9]{24}$/.test(a.id || '') || !Number.isFinite(Date.parse(a.date))) throw Object.assign(Error('historico_evento_invalido'), { codigo: 'historico_evento_invalido' });
        if (rastreio.relevante(a) &&
            (!/^[a-f0-9]{24}$/.test(a.data?.card?.id || '') ||
             (alvo[1] === 'cards' && a.data.card.id !== alvo[2]) ||
             (alvo[1] === 'boards' && a.data.board?.id !== alvo[2]))) {
          throw Object.assign(Error('historico_recurso_divergente'), { codigo: 'historico_recurso_divergente' });
        }
        const d = a.data || {};
        const identidade = JSON.stringify([a.type, a.date, d.card?.id, d.board?.id,
          d.boardSource?.id, d.boardTarget?.id, d.list?.id, d.listBefore?.id,
          d.listAfter?.id, d.old?.closed, d.card?.closed]);
        if (vistos.has(a.id) && vistos.get(a.id) !== identidade) {
          throw Object.assign(Error('historico_evento_conflitante'), { codigo: 'historico_evento_conflitante' });
        }
        if (!vistos.has(a.id)) { vistos.set(a.id, identidade); acoes.push(a); }
      }
      if (pagina.length < 1000) { completo = true; break; }
      const cursor = pagina[pagina.length - 1].id;
      if (cursor === before) break;
      before = cursor;
    }
    if (!completo) throw Object.assign(Error('historico_incompleto'), { codigo: 'historico_incompleto' });
    const relevantes = acoes.filter(rastreio.relevante);
    const novos = await registrar(relevantes, 'carga_setorial');
    if (!pronto) {
      await pool.query(`CREATE TABLE IF NOT EXISTS relogio_setor_coletas (
        recurso TEXT PRIMARY KEY, consultado_em TIMESTAMPTZ NOT NULL,
        desde TIMESTAMPTZ, quantidade INTEGER NOT NULL, novos INTEGER NOT NULL,
        sha256 TEXT NOT NULL)`);
      pronto = true;
    }
    await pool.query(`INSERT INTO relogio_setor_coletas(recurso,consultado_em,desde,quantidade,novos,sha256)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(recurso) DO UPDATE SET
      consultado_em=excluded.consultado_em,desde=excluded.desde,quantidade=excluded.quantidade,
      novos=excluded.novos,sha256=excluded.sha256`,
    [path, agora(), since, relevantes.length, novos, crypto.createHash('sha256').update(JSON.stringify(acoes)).digest('hex')]);
    return { quantidade: relevantes.length, novos };
  }
  return {
    // Detecta também entradas e saídas rápidas ocorridas entre duas varreduras.
    beforeSweep: async () => {
      for (const board of relogio.QUADROS) {
        const path = `/boards/${board}/actions`;
        let desde = agora().getTime() - 24 * 60 * 60 * 1000;
        try {
          const r = await pool.query('SELECT consultado_em FROM relogio_setor_coletas WHERE recurso=$1', [path]);
          const anterior = new Date(r.rows[0]?.consultado_em).getTime();
          // Depois de uma indisponibilidade longa, retomar a última consulta
          // confirmada com sobreposição, em vez de deixar uma lacuna de dias.
          if (Number.isFinite(anterior)) desde = Math.min(desde, anterior - 60 * 60 * 1000);
        } catch (e) { if (e.code !== '42P01') throw e; }
        await coletar(path, new Date(desde).toISOString());
      }
    },
    refreshHistory: async cardId => {
      if (!/^[a-f0-9]{24}$/.test(cardId)) throw Error('card_id_invalido');
      return coletar(`/cards/${cardId}/actions`);
    }, coletar
  };
}
const coletor = criarColetor();
const servico = relogio.criarServico(coletor);
module.exports = { ...servico, criarColetor };
