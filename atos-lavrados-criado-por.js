'use strict';

const { normalizar } = require('./atos-lavrados-autoria');
const TIPO = 'criado_por_extra_criterio_titular';
const METODO = 'criado_por_extra';
const CAMPOS = ['documento', 'minuta', 'protocolo', 'livro', 'folha'];
const ROTULOS = ['U. criador', 'U.criador', 'Criado Por'];
const criterio = 'Critério gerencial expresso do titular de 13/10/2026: o autor da escritura é a pessoa individual identificada no campo Criado Por (U. criador) do Extra Digital, conferido nos campos originais do ato e na fonte importada. Não representa prova de execução física da lavratura ou do evento de registro. Substitui os critérios anteriores mediante revisão explícita, preservando seu histórico; não há atribuição de receita financeira por esta regra.';

function validar(p, { texto, corte, invalido }) {
  const e = p.evidencia;
  if (p.colaborador !== undefined || e.metodo !== undefined || e.decisao !== undefined || e.sha256_calculado !== undefined) throw invalido('Criado Por é conferido e resolvido pelo servidor');
  if (e.marco !== 'atribuicao_gerencial') throw invalido('Criado Por exige marco atribuicao_gerencial');
  if (!ROTULOS.includes(e.campo_ou_evento)) throw invalido('preserve o rótulo literal U. criador ou Criado Por existente nos originais');
  texto(e.valor_original, 2000);
  const ato = Object.fromEntries(CAMPOS.map(k => [k, k === 'protocolo' && e.ato?.[k] === '' ? '' : texto(e.ato?.[k], 200)]));
  const f = e.fonte;
  if (!f || f.sistema !== 'Extra Digital' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(f.lote_id || '') || !/^[a-f0-9]{64}$/i.test(f.sha256 || '')) throw invalido('fonte exige sistema Extra Digital, lote importado e SHA256 original');
  return { chave: p.chave, revisao_base: p.revisao_base, situacao: 'confirmada', colaborador: null, marco: 'atribuicao_gerencial',
    evidencia: { tipo: TIPO, marco: 'atribuicao_gerencial', ato, campo_ou_evento: e.campo_ou_evento, valor_original: e.valor_original,
      fonte: { sistema: 'Extra Digital', lote_id: f.lote_id.toLowerCase(), sha256: f.sha256.toLowerCase(), referencia: texto(f.referencia, 2000), coletado_em: corte(f.coletado_em).instante } } };
}

function decidir(p, registro, cadastro, fonteImportada, { erro, hash, canonico, agora = new Date() }) {
  const e = p.evidencia, f = e.fonte;
  if (CAMPOS.some(k => registro[k] !== e.ato[k])) throw erro(409, 'IDENTIDADE_DIVERGENTE', 'a evidência não corresponde à identidade atual do ato');
  if (registro.originais?.[e.campo_ou_evento] !== e.valor_original) throw erro(409, 'CRIADOR_DIVERGENTE_DA_FONTE', 'rótulo ou valor diverge dos campos originais importados');
  const rotulos = ROTULOS.filter(k => Object.hasOwn(registro.originais || {}, k));
  if (rotulos.some(k => typeof registro.originais[k] !== 'string' || normalizar(registro.originais[k]) !== normalizar(e.valor_original))) throw Object.assign(erro(422, 'PENDENTE_SEM_ATRIBUICAO', 'campos de criador contraditórios; nenhuma atribuição foi alterada'), { pendencias: ['CRIADORES_ORIGINAIS_DIVERGENTES'] });
  if (!fonteImportada || fonteImportada.lote_id !== f.lote_id || fonteImportada.fonte?.sistema !== 'Extra Digital' || typeof fonteImportada.fonte.sha256 !== 'string' || fonteImportada.fonte.sha256.toLowerCase() !== f.sha256 || typeof fonteImportada.fonte.arquivo !== 'string' || !fonteImportada.fonte.arquivo.trim()) throw erro(409, 'FONTE_IMPORTADA_DIVERGENTE', 'o hash e o lote devem identificar a fonte ativa do ato');
  if (!Number.isFinite(+agora) || Date.parse(f.coletado_em) > +agora) throw erro(400, 'EVIDENCIA_TEMPORAL_INVALIDA', 'a coleta original não pode estar no futuro');
  const partes = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(f.coletado_em));
  const parte = k => partes.find(x => x.type === k).value;
  if (`${parte('year')}-${parte('month')}-${parte('day')}` < registro.data_lavratura) throw erro(400, 'EVIDENCIA_TEMPORAL_INVALIDA', 'a coleta precisa alcançar a data de lavratura do ato');
  const login = normalizar(e.valor_original);
  const pessoas = cadastro.filter(c => normalizar(c.login) === login);
  const pendente = motivo => { throw Object.assign(erro(422, 'PENDENTE_SEM_ATRIBUICAO', 'criador sem identidade individual comprovada; nenhuma atribuição foi alterada'), { pendencias: [motivo] }); };
  if (pessoas.length !== 1) pendente('CRIADOR_LOGIN_NAO_UNICO_NO_CADASTRO');
  const c = pessoas[0], cargo = typeof c.cargo === 'string' ? normalizar(c.cargo).normalize('NFD').replace(/[\u0300-\u036f]/g, '') : '';
  const papel = c.escrevente === true ? 'escrevente' : cargo === 'tabeliao' ? 'tabeliao' : null;
  if (!papel || typeof c.nome !== 'string' || !c.nome.trim() || !/^[a-z0-9][a-z0-9._-]*$/.test(login)) pendente('CRIADOR_PESSOA_INDIVIDUAL_NAO_CONFERIDA');
  const colaborador = { id: login, nome: c.nome };
  const evidencia = { ...e, metodo: METODO, decisao: { criterio_identidade: 'login_criador_extra_igual_login_cadastro',
    colaborador: { ...colaborador, papel }, fonte_importada: { lote_id: f.lote_id, sha256: f.sha256, arquivo: fonteImportada.fonte.arquivo } } };
  evidencia.sha256_calculado = hash(canonico(evidencia));
  return { ...p, colaborador, evidencia };
}

module.exports = { TIPO, METODO, criterio, validar, decidir };
