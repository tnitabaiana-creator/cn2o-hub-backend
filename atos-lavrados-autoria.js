'use strict';

// A evidência direta continua independente. Este complemento é uma convenção
// gerencial do titular, e não transforma uma alteração em evento de registro.
const TIPO = 'auditoria_trello_criterio_titular';
const CAMPOS = ['documento', 'minuta', 'protocolo', 'livro', 'folha'];
const normalizar = s => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
const criterio = 'Evidência direta de quem lavrou ou registrou tem prioridade. Na sua ausência, pelo critério gerencial do titular, compara-se o último escrevente da auditoria com o responsável explícito e único no Trello: concordância confirma esse colaborador; divergência prevalece o responsável no Trello. Evidência insuficiente mantém a pendência, sem remover atribuição válida.';

function validar(p, V) {
  const { texto, corte, invalido } = V;
  const original = v => { texto(v, 2000); return v; };
  const e = p.evidencia;
  if (p.colaborador !== undefined || e.metodo !== undefined || e.decisao !== undefined || e.sha256_calculado !== undefined) throw invalido('a decisão gerencial é calculada pelo servidor, não recebe colaborador ou método escolhido');
  if (e.marco !== 'atribuicao_gerencial') throw invalido('o complemento usa marco atribuicao_gerencial');
  const identidade = a => Object.fromEntries(CAMPOS.map(k => [k, k === 'protocolo' && a?.[k] === '' ? '' : texto(a?.[k], 200)]));
  const pessoa = a => {
    if (a == null) return null;
    const id = normalizar(texto(a.id, 160));
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw invalido('login do colaborador inválido');
    return { id, nome: texto(a.nome, 200) };
  };
  const fonte = f => {
    if (!f || typeof f !== 'object') throw invalido('fontes da auditoria e do Trello são obrigatórias');
    const sha256 = texto(f.sha256, 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw invalido('hash da fonte inválido');
    return { referencia: texto(f.referencia, 2000), sha256, coletado_em: corte(f.coletado_em).instante, ato: identidade(f.ato) };
  };
  const auditoria = fonte(e.auditoria), trello = fonte(e.trello), corte_em = corte(e.corte_em).instante;
  if (typeof e.auditoria.completa_ate_corte !== 'boolean') throw invalido('declare a completude da auditoria até o corte');
  if (!Array.isArray(e.auditoria.eventos) || e.auditoria.eventos.length > 10000) throw invalido('auditoria exige lista de até 10 mil eventos');
  const ids = new Set();
  auditoria.completa_ate_corte = e.auditoria.completa_ate_corte;
  auditoria.eventos = e.auditoria.eventos.map(x => {
    const id = texto(x?.id, 200);
    if (ids.has(id)) throw invalido('evento de auditoria repetido'); ids.add(id);
    if (!['alteracao_minuta', 'alteracao_protocolo'].includes(x.acao)) throw invalido('evento deve identificar alteração de minuta ou protocolo');
    const em = corte(x.em).instante;
    if (Date.parse(em) > Date.parse(corte_em)) throw invalido('evento posterior ao corte da auditoria');
    return { id, em, acao: x.acao, usuario_original: original(x.usuario_original), colaborador: pessoa(x.colaborador) };
  });
  if (!Array.isArray(e.trello.responsaveis) || e.trello.responsaveis.length > 100) throw invalido('Trello exige lista de responsáveis explícitos');
  const cartao_id = texto(e.trello.cartao_id, 24);
  if (!/^[a-f0-9]{24}$/.test(cartao_id)) throw invalido('ID integral do cartão Trello inválido');
  Object.assign(trello, { cartao_id, campo_responsavel: texto(e.trello.campo_responsavel, 200), responsaveis: e.trello.responsaveis.map(x => ({ valor_original: original(x?.valor_original), colaborador: pessoa(x.colaborador) })) });
  for (const f of [auditoria, trello]) if (Date.parse(f.coletado_em) < Date.parse(corte_em)) throw invalido('a coleta deve comprovar a fonte até o corte declarado');
  const ato = identidade(e.ato);
  for (const f of [auditoria, trello]) if (CAMPOS.some(k => f.ato[k] !== ato[k])) throw invalido('ato, auditoria e cartão devem apresentar a mesma identidade completa');
  return { chave: p.chave, revisao_base: p.revisao_base, situacao: 'confirmada', colaborador: null, marco: 'atribuicao_gerencial',
    evidencia: { tipo: TIPO, marco: 'atribuicao_gerencial', corte_em, ato, auditoria, trello } };
}

function decidir(p, registro, cadastro, V) {
  const { erro, hash, canonico } = V, e = p.evidencia;
  if (CAMPOS.some(k => registro[k] !== e.ato[k])) throw erro(409, 'IDENTIDADE_DIVERGENTE', 'a evidência não corresponde à identidade atual do ato; confira sua versão');
  // O relógio só é injetável na função interna de teste, nunca pelo corpo HTTP.
  const agora = +(V.agora || new Date());
  const instantes = [e.corte_em, e.auditoria.coletado_em, e.trello.coletado_em, ...e.auditoria.eventos.map(x => x.em)];
  if (!Number.isFinite(agora) || instantes.some(x => Date.parse(x) > agora)) throw erro(400, 'EVIDENCIA_TEMPORAL_INVALIDA', 'corte, coletas e eventos não podem estar no futuro');
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(e.corte_em));
  const parte = k => partes.find(x => x.type === k).value;
  if (`${parte('year')}-${parte('month')}-${parte('day')}` < registro.data_lavratura) throw erro(400, 'EVIDENCIA_TEMPORAL_INVALIDA', 'o corte deve alcançar a data da lavratura em America/Sao_Paulo');
  const pendencias = new Set();
  const pendente = () => { throw Object.assign(erro(422, 'PENDENTE_SEM_ATRIBUICAO', 'evidências insuficientes ou ambíguas; nenhuma atribuição foi alterada'), { pendencias: [...pendencias].sort() }); };
  const cadastroNormal = cadastro.map(c => ({ id: normalizar(c.login), nome: c.nome, escrevente: c.escrevente,
    nomes: [c.nome, ...(c.aliases || [])].filter(x => typeof x === 'string' && x.trim()).map(normalizar) }));
  const resolver = (raw, indicado, origem) => {
    const n = normalizar(raw), candidatos = cadastroNormal.filter(c => c.id === n || c.nomes.includes(n));
    if (candidatos.length !== 1) { pendencias.add(origem + '_IDENTIDADE_NAO_CONFERIDA'); return null; }
    const c = candidatos[0];
    if (indicado && (indicado.id !== c.id || normalizar(indicado.nome) !== normalizar(c.nome))) { pendencias.add(origem + '_COLABORADOR_DIVERGENTE'); return null; }
    return c;
  };
  if (!e.auditoria.completa_ate_corte) pendencias.add('AUDITORIA_INCOMPLETA');
  const eventos = e.auditoria.eventos.map(x => ({ ...x, pessoa: resolver(x.usuario_original, x.colaborador, 'AUDITORIA') }));
  const escreventes = eventos.filter(x => x.pessoa?.escrevente).sort((a, b) => Date.parse(b.em) - Date.parse(a.em));
  const ultimo = escreventes[0];
  const ultimos = ultimo ? escreventes.filter(x => Date.parse(x.em) === Date.parse(ultimo.em)) : [];
  if (!ultimo) pendencias.add('SEM_ULTIMO_ESCREVENTE');
  // Empate do mesmo escrevente não muda o crédito; pessoas diferentes exigem ordem comprovada.
  if (new Set(ultimos.map(x => x.pessoa.id)).size > 1) pendencias.add('ULTIMO_EVENTO_AMBIGUO');
  if (e.trello.responsaveis.length !== 1) pendencias.add('TRELLO_RESPONSAVEL_NAO_UNICO');
  const responsavel = e.trello.responsaveis.length === 1 ? resolver(e.trello.responsaveis[0].valor_original, e.trello.responsaveis[0].colaborador, 'TRELLO') : null;
  if (responsavel && !responsavel.escrevente) pendencias.add('TRELLO_RESPONSAVEL_NAO_ESCREVENTE');
  if (pendencias.size) pendente();
  const metodo = ultimo.pessoa.id === responsavel.id ? 'auditoria_concordante' : 'trello_divergencia';
  // Preserva o instantâneo do cadastro usado na decisão, inclusive desligados.
  const evidencia = { ...e, metodo, decisao: { ultimo_evento_id: ultimos.length === 1 ? ultimo.id : null,
    ultimos_eventos_ids: ultimos.map(x => x.id).sort(),
    ultimo_escrevente: { id: ultimo.pessoa.id, nome: ultimo.pessoa.nome },
    responsavel_trello: { id: responsavel.id, nome: responsavel.nome },
    colaboradores_conferidos: [...new Map([...eventos.map(x => x.pessoa), responsavel].filter(Boolean).map(c => [c.id, { id: c.id, nome: c.nome, escrevente: c.escrevente }])).values()].sort((a, b) => a.id.localeCompare(b.id)) } };
  evidencia.sha256_calculado = hash(canonico(evidencia));
  return { ...p, colaborador: { id: responsavel.id, nome: responsavel.nome }, evidencia };
}
module.exports = { TIPO, criterio, normalizar, validar, decidir };
