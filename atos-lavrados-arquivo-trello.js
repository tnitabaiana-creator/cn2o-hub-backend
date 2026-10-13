'use strict';

const { normalizar } = require('./atos-lavrados-autoria');
const TIPO = 'trello_movimentacao_arquivo_criterio_titular';
const METODO = 'movimentacao_arquivo_trello';
const METODO_ANTERIOR = 'ultimo_escrevente_antes_arquivo_trello';
const QUADRO = '692e0379fa55156e778f27ef';
const LISTAS = Object.freeze(['69344a6fc5e00099568028f9', '6a94ce7feba0f0d9ab600e9b', '6a143e210fea5dbc7500a27b']);
const CAMPOS = ['documento', 'minuta', 'protocolo', 'livro', 'folha'];
const criterio = 'Critério gerencial do titular de 13/10/2026: atribui a escritura ao escrevente cuja conta Trello consta na última entrada comprovada do cartão vinculado no arquivo do Protocolo/Cadastro. Se o arquivo foi movimentado por conta genérica ou não individual de escrevente, usa a última movimentação anterior de escrevente identificado, mesmo em outra etapa. Movimentos entre arquivos não redistribuem o crédito; comentários e campos não identificam o responsável. Não exige auditoria CTN nem comprova clique manual ou lavratura física; evidência direta vigente continua prioritária. Fonte insuficiente mantém pendência.';

function validar(p, V) {
  const { texto, corte, invalido } = V, e = p.evidencia;
  if (p.colaborador !== undefined || e.metodo !== undefined || e.decisao !== undefined || e.sha256_calculado !== undefined) throw invalido('a atribuição pelo arquivo é calculada pelo servidor');
  if (e.marco !== 'atribuicao_gerencial') throw invalido('movimentação de arquivo exige marco atribuicao_gerencial');
  const id = v => { const s = texto(v, 24); if (!/^[a-f0-9]{24}$/.test(s)) throw invalido('ID integral Trello inválido'); return s; };
  const identidade = a => Object.fromEntries(CAMPOS.map(k => [k, k === 'protocolo' && a?.[k] === '' ? '' : texto(a?.[k], 200)]));
  const fonte = f => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw invalido('fontes do vínculo e do histórico Trello são obrigatórias');
    const sha256 = texto(f.sha256, 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw invalido('hash da fonte inválido');
    return { referencia: texto(f.referencia, 2000), sha256, coletado_em: corte(f.coletado_em).instante, ato: identidade(f.ato), cartao_id: id(f.cartao_id) };
  };
  const pessoa = c => {
    if (c == null) return null;
    const login = normalizar(texto(c.id, 160));
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(login)) throw invalido('login do colaborador inválido');
    return { id: login, nome: texto(c.nome, 200) };
  };
  const lista = (l, permitirAusente = false) => l == null && permitirAusente ? null : { id: id(l?.id), name: texto(l?.name, 200) };
  const identidadeConferida = (v, trelloId) => {
    if (v == null) return null;
    const trello_id = id(v.trello_id), login_hub = normalizar(texto(v.login_hub, 160));
    if (trello_id !== trelloId || !/^[a-z0-9][a-z0-9._-]*$/.test(login_hub)) throw invalido('vínculo da identidade não corresponde ao criador Trello');
    const sha256 = texto(v.sha256, 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw invalido('hash do vínculo da identidade inválido');
    return { trello_id, login_hub, referencia: texto(v.referencia, 2000), sha256, coletado_em: corte(v.coletado_em).instante };
  };
  const ato = identidade(e.ato), corte_em = corte(e.corte_em).instante;
  const vinculo = fonte(e.vinculo), trello = fonte(e.trello);
  if (typeof e.vinculo.confirmado_unico !== 'boolean' || typeof e.trello.historico_completo_ate_corte !== 'boolean') throw invalido('declare a unicidade do vínculo e a completude do histórico');
  vinculo.confirmado_unico = e.vinculo.confirmado_unico;
  for (const f of [vinculo, trello]) {
    if (CAMPOS.some(k => f.ato[k] !== ato[k]) || f.cartao_id !== trello.cartao_id) throw invalido('ato, vínculo e cartão devem apresentar a mesma identidade');
    if (Date.parse(f.coletado_em) < Date.parse(corte_em)) throw invalido('coleta anterior ao corte declarado');
  }
  if (id(e.trello.quadro?.id) !== QUADRO) throw invalido('quadro não autorizado para o critério de arquivo');
  trello.quadro = { id: QUADRO, nome: texto(e.trello.quadro.nome, 200) };
  if (!Array.isArray(e.trello.listas_arquivo) || !e.trello.listas_arquivo.length || e.trello.listas_arquivo.length > LISTAS.length) throw invalido('declare as listas de arquivo conferidas');
  trello.listas_arquivo = e.trello.listas_arquivo.map(l => ({ id: id(l?.id), nome: texto(l?.nome, 200) }));
  if (new Set(trello.listas_arquivo.map(l => l.id)).size !== trello.listas_arquivo.length || trello.listas_arquivo.some(l => !LISTAS.includes(l.id))) throw invalido('lista de arquivo fora da configuração autorizada');
  trello.historico_completo_ate_corte = e.trello.historico_completo_ate_corte;
  if (!Array.isArray(e.trello.movimentacoes) || e.trello.movimentacoes.length > 10000) throw invalido('envie até 10 mil movimentos do histórico');
  const ids = new Set();
  trello.movimentacoes = e.trello.movimentacoes.map(x => {
    const actionId = id(x?.id); if (ids.has(actionId)) throw invalido('ação Trello repetida'); ids.add(actionId);
    if (!['updateCard', 'moveCardToBoard'].includes(x.type)) throw invalido('tipo de movimentação não reconhecido');
    const date = corte(x.date).instante;
    if (Date.parse(date) > Date.parse(corte_em)) throw invalido('movimentação posterior ao corte');
    const cartao_id = id(x.cartao_id), quadro_id = x.quadro_id == null ? null : id(x.quadro_id);
    if (cartao_id !== trello.cartao_id) throw invalido('movimentação pertence a outro cartão');
    const quadro_antes = x.quadro_antes == null ? null : id(x.quadro_antes);
    if (x.type === 'moveCardToBoard' && quadro_antes !== null && quadro_antes === quadro_id) throw invalido('origem e destino da mudança de quadro não podem ser iguais');
    if (x.type === 'updateCard' && quadro_antes !== null && quadro_id !== null && quadro_antes !== quadro_id) throw invalido('mudança entre quadros exige moveCardToBoard');
    const listBefore = lista(x.listBefore, x.type === 'moveCardToBoard'), listAfter = lista(x.listAfter, x.type === 'moveCardToBoard');
    if (x.type === 'updateCard' && listBefore.id === listAfter.id) throw invalido('a ação não mudou a lista');
    const c = x.criador;
    if (!c || !['humano', 'bot', 'desconhecido'].includes(c.tipo)) throw invalido('declare o tipo de criador comprovado na fonte');
    if (x.automacao != null && typeof x.automacao !== 'boolean') throw invalido('declare se a ação é automatizada');
    if (x.appCreator != null && (typeof x.appCreator !== 'object' || Array.isArray(x.appCreator))) throw invalido('appCreator inválido');
    return { id: actionId, type: x.type, date, cartao_id, quadro_id, quadro_antes, listBefore, listAfter,
      display_key: x.display_key == null ? null : texto(x.display_key, 200),
      automacao: x.automacao == null ? null : x.automacao,
      appCreator: x.appCreator == null ? null : { id: id(x.appCreator.id) },
      criador: { id: id(c.id), nome: texto(c.nome, 200), username: c.username == null ? null : texto(c.username, 160), tipo: c.tipo,
        colaborador_hub: pessoa(c.colaborador_hub), identidade_conferida: identidadeConferida(c.identidade_conferida, id(c.id)) } };
  });
  return { chave: p.chave, revisao_base: p.revisao_base, situacao: 'confirmada', colaborador: null, marco: 'atribuicao_gerencial',
    evidencia: { tipo: TIPO, marco: 'atribuicao_gerencial', corte_em, ato, vinculo, trello } };
}

function decidir(p, registro, cadastro, V) {
  const { erro, hash, canonico } = V, e = p.evidencia;
  if (CAMPOS.some(k => registro[k] !== e.ato[k])) throw erro(409, 'IDENTIDADE_DIVERGENTE', 'o vínculo não corresponde à identidade atual do ato');
  const agora = +(V.agora || new Date()), instantes = [e.corte_em, e.vinculo.coletado_em, e.trello.coletado_em, ...e.trello.movimentacoes.flatMap(x => [x.date, x.criador.identidade_conferida?.coletado_em].filter(Boolean))];
  if (!Number.isFinite(agora) || instantes.some(x => Date.parse(x) > agora)) throw erro(400, 'EVIDENCIA_TEMPORAL_INVALIDA', 'corte, coletas e movimentos não podem estar no futuro');
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(e.corte_em));
  const parte = k => partes.find(x => x.type === k).value;
  if (`${parte('year')}-${parte('month')}-${parte('day')}` < registro.data_lavratura) throw erro(400, 'EVIDENCIA_TEMPORAL_INVALIDA', 'o corte deve alcançar a data da lavratura em Brasília');
  const pendencias = new Set();
  if (!e.vinculo.confirmado_unico) pendencias.add('VINCULO_ATO_CARTAO_NAO_UNICO');
  if (!e.trello.historico_completo_ate_corte) pendencias.add('HISTORICO_TRELLO_INCOMPLETO');
  // O conjunto aprovado é fixo: omitir uma lista no pedido não transforma uma reorganização em ingresso.
  const candidatos = e.trello.movimentacoes.filter(x => x.quadro_id === QUADRO && LISTAS.includes(x.listAfter?.id)
    && (x.type === 'moveCardToBoard' || !LISTAS.includes(x.listBefore.id))).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  let ultimo = candidatos[0], ultimos = ultimo ? candidatos.filter(x => Date.parse(x.date) === Date.parse(ultimo.date)) : [];
  let transferenciaIndeterminada = null, constatacao = false;
  // Um destino omitido não é preenchido com a lista atual. Pode haver uma prova
  // posterior de estado arquivado, cuja janela de ingresso precisa ficar explícita.
  const transferenciasIncertas = e.trello.movimentacoes.filter(x => x.type === 'moveCardToBoard'
    && (x.quadro_id === null || (x.quadro_id === QUADRO && x.listAfter === null)))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const transferencia = transferenciasIncertas[0];
  if (transferencia && ultimo && Date.parse(transferencia.date) === Date.parse(ultimo.date)) pendencias.add('ORDEM_MOVIMENTACOES_AMBIGUA');
  if (transferencia && (!ultimo || Date.parse(transferencia.date) > Date.parse(ultimo.date))) {
    const provas = e.trello.movimentacoes.filter(x => x.type === 'updateCard' && x.quadro_id === QUADRO
      && LISTAS.includes(x.listBefore.id) && LISTAS.includes(x.listAfter.id) && Date.parse(x.date) > Date.parse(transferencia.date))
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    if (provas.length) {
      transferenciaIndeterminada = transferencia; constatacao = true; ultimo = provas[0];
      ultimos = provas.filter(x => Date.parse(x.date) === Date.parse(ultimo.date));
    } else pendencias.add('ENTRADA_POSTERIOR_NAO_DETERMINADA');
  }
  // Um ID de arquivo sem quadro comprovado não confirma novo ingresso, mas
  // tampouco permite conservar silenciosamente o crédito de um ingresso antigo.
  if (ultimo && e.trello.movimentacoes.some(x => x.type === 'updateCard' && x.quadro_id === null
    && LISTAS.includes(x.listAfter.id) && !LISTAS.includes(x.listBefore.id)
    && Date.parse(x.date) >= Date.parse(ultimo.date))) pendencias.add('ENTRADA_POSTERIOR_NAO_DETERMINADA');
  if (!ultimo) pendencias.add('SEM_ENTRADA_COMPROVADA_NO_ARQUIVO');
  if (new Set(ultimos.map(x => x.criador.id)).size > 1) pendencias.add('ULTIMA_MOVIMENTACAO_AMBIGUA');
  const normal = cadastro.map(c => ({ id: normalizar(c.login), nome: c.nome, escrevente: c.escrevente,
    nomes: [c.nome, ...(c.aliases || [])].filter(x => typeof x === 'string' && x.trim()).map(normalizar) }));
  const resolver = x => {
    // O conector pode não expor automação/appCreator. Ausência permanece desconhecida,
    // sem afirmar clique manual; somente sinal positivo impede crédito individual.
    if (x.automacao === true || x.appCreator !== null || x.criador.tipo === 'bot') return { tipo: 'automacao' };
    if ([x.criador.nome, x.criador.username].filter(Boolean).some(n => normalizar(n).replace(/[^a-z0-9]/g, '') === 'tnitabaiana')) return { tipo: 'generica' };
    if (x.criador.tipo !== 'humano') return { tipo: 'desconhecida' };
    const raw = [x.criador.nome, x.criador.username].filter(Boolean).map(normalizar);
    const vinculoPessoa = x.criador.identidade_conferida;
    const pessoas = normal.filter(c => vinculoPessoa ? c.id === vinculoPessoa.login_hub : raw.some(n => c.id === n || c.nomes.includes(n)));
    if (pessoas.length !== 1) return { tipo: 'desconhecida' };
    const c = pessoas[0], indicado = x.criador.colaborador_hub;
    if (indicado && (indicado.id !== c.id || normalizar(indicado.nome) !== normalizar(c.nome))) return { tipo: 'divergente' };
    return { tipo: c.escrevente ? 'escrevente' : 'nao_escrevente', pessoa: c };
  };
  let selecionados = ultimos.map(x => ({ evento: x, ...resolver(x) })), metodo = METODO;
  if (!constatacao && selecionados.some(x => x.tipo === 'desconhecida')) pendencias.add('ATOR_ARQUIVO_NAO_IDENTIFICADO');
  if (!constatacao && selecionados.some(x => x.tipo === 'divergente')) pendencias.add('ATOR_TRELLO_COLABORADOR_DIVERGENTE');
  if (!constatacao && selecionados.some(x => x.tipo === 'escrevente') && selecionados.some(x => x.tipo !== 'escrevente')) pendencias.add('ORIGEM_ULTIMA_MOVIMENTACAO_AMBIGUA');
  if (constatacao) {
    const janela = e.trello.movimentacoes.filter(x => Date.parse(x.date) > Date.parse(transferenciaIndeterminada.date) && Date.parse(x.date) < Date.parse(ultimo.date));
    if (janela.some(x => !['generica', 'automacao'].includes(resolver(x).tipo))) pendencias.add('MOVIMENTO_INDIVIDUAL_NA_JANELA_INDETERMINADA');
    if (transferenciasIncertas.filter(x => Date.parse(x.date) === Date.parse(transferenciaIndeterminada.date)).length !== 1) pendencias.add('ORDEM_MOVIMENTACOES_AMBIGUA');
  }
  if (selecionados.length && (constatacao || selecionados.every(x => ['generica', 'nao_escrevente', 'automacao'].includes(x.tipo)))) {
    metodo = METODO_ANTERIOR;
    // Só movimentos reais anteriores ao ingresso: não comentários, campos ou organização posterior.
    const anteriores = e.trello.movimentacoes.filter(x => Date.parse(x.date) < Date.parse(ultimo.date))
      .map(x => ({ evento: x, ...resolver(x) })).sort((a, b) => Date.parse(b.evento.date) - Date.parse(a.evento.date));
    const escritor = anteriores.find(x => x.tipo === 'escrevente');
    selecionados = escritor ? anteriores.filter(x => x.tipo === 'escrevente' && Date.parse(x.evento.date) === Date.parse(escritor.evento.date)) : [];
    if (!escritor) pendencias.add('SEM_ESCREVENTE_ANTERIOR_AO_ARQUIVO');
    const posterioresOuEmpatados = anteriores.filter(x => !escritor || Date.parse(x.evento.date) >= Date.parse(escritor.evento.date));
    if (posterioresOuEmpatados.some(x => ['desconhecida', 'divergente'].includes(x.tipo))) pendencias.add('MOVIMENTADOR_INTERMEDIARIO_NAO_IDENTIFICADO');
    if (e.trello.movimentacoes.some(x => Date.parse(x.date) === Date.parse(ultimo.date) && !ultimos.some(a => a.id === x.id) && resolver(x).tipo === 'escrevente')) pendencias.add('ORDEM_MOVIMENTACOES_AMBIGUA');
  }
  if (new Set(selecionados.map(x => x.pessoa?.id).filter(Boolean)).size > 1 || new Set(selecionados.map(x => x.evento.criador.id)).size > 1) pendencias.add('ULTIMA_MOVIMENTACAO_AMBIGUA');
  if (pendencias.size) throw Object.assign(erro(422, 'PENDENTE_SEM_ATRIBUICAO', 'evidências insuficientes ou ambíguas; nenhuma atribuição foi alterada'), { pendencias: [...pendencias].sort() });
  const c = selecionados[0].pessoa, escolhido = selecionados[0].evento;
  const evidencia = { ...e, metodo, decisao: {
    regra: constatacao ? 'primeira_constatacao_arquivo_com_janela_indeterminada' : 'ultima_entrada_nao_arquivo_para_arquivo', quadro_id: QUADRO,
    cartao_id: e.trello.cartao_id, ultimas_acoes_ids: ultimos.map(x => x.id).sort(),
    marco_arquivo: { tipo: constatacao ? 'primeira_constatacao_arquivo' : 'entrada_no_arquivo', acoes_ids: ultimos.map(x => x.id).sort(), em: ultimo.date, ator_trello_id: ultimo.criador.id },
    janela_entrada_indeterminada: constatacao ? { transferencia_acao_id: transferenciaIndeterminada.id, desde: transferenciaIndeterminada.date, ate: ultimo.date, destino_transferencia: transferenciaIndeterminada.listAfter } : null,
    movimentacao_escrevente: { acoes_ids: selecionados.map(x => x.evento.id).sort(), em: escolhido.date, ator_trello_id: escolhido.criador.id },
    origem_ator: metodo === METODO ? 'criador_movimento_arquivo' : 'ultima_movimentacao_escrevente_anterior',
    motivo: metodo === METODO ? 'conta_arquivo_identificada_como_escrevente' : 'conta_arquivo_generica_ou_nao_individual_de_escrevente',
    movimentado_em: escolhido.date, ator_trello_id: escolhido.criador.id,
    origem_execucao: selecionados.some(x => x.evento.automacao === null) ? 'fonte_nao_informa' : 'fonte_sem_sinal_de_automacao',
    colaborador_conferido: { id: c.id, nome: c.nome, escrevente: c.escrevente },
    criterio_identidade: escolhido.criador.identidade_conferida ? 'vinculo_documental_trello_login_hub' : 'nome_login_alias_exato',
    listas_arquivo_autorizadas: [...LISTAS]
  } };
  evidencia.sha256_calculado = hash(canonico(evidencia));
  return { ...p, colaborador: { id: c.id, nome: c.nome }, evidencia };
}

module.exports = { TIPO, METODO, METODO_ANTERIOR, QUADRO, LISTAS, criterio, validar, decidir };
