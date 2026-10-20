'use strict';

// Carteira atual do relatório legado. O due do Trello pode ser a agenda de
// assinatura; somente o vencimento persistido pelo Relógio do Ato mede atraso.
const TRABALHO = new Set(['elaboracao', 'retrabalho', 'conferencia', 'pendencia', 'assinatura']);
const LIMITE_CONFIRMACAO_MS = 30 * 60 * 1000;

function resumir(cartoes, linhas, login, agora = new Date()) {
  const corte = new Date(agora).getTime();
  if (!Number.isFinite(corte)) throw Error('corte_wip_invalido');
  const porId = new Map(linhas.map(linha => [linha.card_id, linha]));
  const ids = new Set(cartoes.map(cartao => cartao.id));
  const resumo = {
    total: ids.size, atrasados: 0, sem_prazo_confirmado: 0,
    fonte: 'prazos_atos', corte_em: new Date(corte).toISOString()
  };
  for (const id of ids) {
    const prazo = porId.get(id);
    const fim = prazo?.vencimento == null ? NaN : new Date(prazo.vencimento).getTime();
    const confirmado = prazo?.confirmado_em == null ? NaN : new Date(prazo.confirmado_em).getTime();
    if (!prazo || !['ativo', 'assinatura'].includes(prazo.estado) || prazo.erro ||
        prazo.responsavel_login !== login || !Number.isFinite(fim) ||
        !Number.isFinite(confirmado) || confirmado > corte ||
        corte - confirmado > LIMITE_CONFIRMACAO_MS) {
      resumo.sem_prazo_confirmado++;
    } else if (fim < corte) resumo.atrasados++;
  }
  return resumo;
}

async function consultar({ pool, trello, escreventes, rastreio, agora = new Date() }) {
  const carteiras = new Map();
  for (const escrevente of escreventes) {
    try {
      const [listas, cartoes] = await Promise.all([
        trello.t('GET', `/boards/${escrevente.board_id}/lists?fields=name&filter=open`),
        trello.t('GET', `/boards/${escrevente.board_id}/cards?fields=id,idList&filter=open`)
      ]);
      if (!Array.isArray(listas) || !Array.isArray(cartoes) ||
          listas.some(l => !l || typeof l.id !== 'string' || typeof l.name !== 'string') ||
          cartoes.some(c => !c || typeof c.id !== 'string' || !c.id || typeof c.idList !== 'string')) {
        throw Error('carteira_trello_invalida');
      }
      const categorias = new Map(listas.map(l => [l.id, rastreio.categoriaDaLista(l.name)]));
      carteiras.set(escrevente.login, cartoes.filter(c => TRABALHO.has(categorias.get(c.idList))));
    } catch (_) {
      // Ausência de resposta não é uma carteira vazia.
      carteiras.set(escrevente.login, null);
    }
  }
  const ids = [...new Set([...carteiras.values()].flatMap(c => c || []).map(c => c.id))];
  let linhas = [];
  if (ids.length) {
    try {
      const resultado = await pool.query(`SELECT card_id,estado,vencimento,responsavel_login,confirmado_em,erro
        FROM prazos_atos WHERE card_id=ANY($1::text[])`, [ids]);
      linhas = resultado.rows;
    } catch (_) {
      // Mantém o total observado no Trello, com todos os prazos pendentes.
    }
  }
  return Object.fromEntries([...carteiras].map(([login, cartoes]) => [
    login, cartoes === null ? null : resumir(cartoes, linhas, login, agora)
  ]));
}

module.exports = { consultar, resumir, LIMITE_CONFIRMACAO_MS };
