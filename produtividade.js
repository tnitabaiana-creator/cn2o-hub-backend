// produtividade.js — produtividade em reais por escrevente (v1.40).
//
// O Tabelião importa na aba Relatórios a "Pesquisa de Produtividade" do sistema do
// cartório (.xls ou .csv). A planilha é lida NO NAVEGADOR e só os totais chegam aqui:
// por pessoa, por forma de pagamento, por faixa de valor e (quando o arquivo tem data)
// por dia. As linhas da planilha nunca são guardadas.
//
// Montado dentro do relatorios.js (mesma trava de administrador):
//   GET  /hub/relatorios/produtividade                 → meses, configuração e nomes da Equipe
//   GET  /hub/relatorios/produtividade/dias-uteis?mes=AAAA-MM → dias úteis do calendário do Hub
//   POST /hub/relatorios/produtividade/mes     { ano, mes, dados, fonte } → grava (substitui)
//   POST /hub/relatorios/produtividade/apagar  { ano, mes }
//   POST /hub/relatorios/produtividade/config  { corte, ferd, ir }
//   POST /hub/relatorios/produtividade/analisar { ano, mes } → análise da IA, guardada no mês
//
// A IA recebe só os números já somados (nada de linha da planilha) e devolve: um resumo,
// um texto por pessoa, observações de gestão e o que parece fora do padrão.
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const cal = require('./horas-uteis');

const q = (texto, params) => db.pool.query(texto, params);
const RE_MES = /^\d{4}-(0[1-9]|1[0-2])$/;
const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
const CONFIG_PADRAO = { corte: 200, ferd: 16.6667, ir: 27.5 };
const FAIXAS = ['até R$ 5', 'R$ 5–12', 'R$ 12–50', 'R$ 50–200', 'R$ 200–1 mil', 'R$ 1–5 mil', '+ de R$ 5 mil'];
const LIM = { pessoas: 80, pgto: 40, dias: 31, texto: 120 };

// ---------------------------------------------------------------- banco
async function init() {
  await q(`
    CREATE TABLE IF NOT EXISTS produtividade_mes (
      ano           INTEGER NOT NULL,
      mes           INTEGER NOT NULL,
      dados         JSONB NOT NULL,
      fonte         TEXT,
      importado_por TEXT,
      importado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
      analise       JSONB,
      analise_em    TIMESTAMPTZ,
      PRIMARY KEY (ano, mes)
    );
    CREATE TABLE IF NOT EXISTS produtividade_config (
      chave TEXT PRIMARY KEY,
      valor JSONB NOT NULL
    );
  `);
  // carga inicial: os três meses do painel anterior (junho a agosto de 2026), uma vez só —
  // se o Tabelião apagar um deles depois, ele não volta no próximo reinício
  const r = await q(`SELECT 1 FROM produtividade_config WHERE chave = 'semeado'`);
  if (!r.rows.length) {
    const ini = JSON.parse(fs.readFileSync(path.join(__dirname, 'dados', 'produtividade-inicial.json'), 'utf8'));
    for (const m of ini) {
      await q(`INSERT INTO produtividade_mes (ano, mes, dados, fonte, importado_por) VALUES ($1, $2, $3, $4, 'painel anterior')
               ON CONFLICT (ano, mes) DO NOTHING`, [m.ano, m.mes, JSON.stringify(validarDados(m.dados)), m.fonte]);
    }
    await q(`INSERT INTO produtividade_config (chave, valor) VALUES ('semeado', 'true') ON CONFLICT (chave) DO NOTHING`);
  }
}

async function lerConfig() {
  const r = await q(`SELECT valor FROM produtividade_config WHERE chave = 'geral'`);
  return Object.assign({}, CONFIG_PADRAO, (r.rows[0] && r.rows[0].valor) || {});
}

// ---------------------------------------------------------------- validação
function erro400(msg) { return Object.assign(new Error(msg), { status: 400 }); }
const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n || LIM.texto);
function numero(v, rotulo, { min = 0, max = 1e9, inteiro = false, nulo = false } = {}) {
  if (v == null || v === '') { if (nulo) return null; throw erro400(rotulo + ' ausente'); }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (inteiro && !Number.isInteger(n))) throw erro400(rotulo + ' inválido');
  return inteiro ? n : Math.round(n * 100) / 100;
}
// O que o navegador manda é conferido campo a campo: só números e textos curtos entram.
function validarDados(d) {
  if (!d || typeof d !== 'object') throw erro400('dados do mês ausentes');
  const pessoas = (Array.isArray(d.pessoas) ? d.pessoas : []).slice(0, LIM.pessoas + 1);
  if (!pessoas.length) throw erro400('nenhuma pessoa na planilha');
  if (pessoas.length > LIM.pessoas) throw erro400('pessoas demais na planilha');
  const ids = new Set();
  const P = pessoas.map((p, i) => {
    const id = txt(p && p.id, 80);
    if (!id) throw erro400('pessoa ' + (i + 1) + ' sem identificação');
    if (ids.has(id)) throw erro400('pessoa repetida: ' + id);
    ids.add(id);
    return {
      id, nome: txt(p.nome, 120) || null,
      atos: numero(p.atos, 'atos de ' + id, { inteiro: true, max: 1e6 }),
      total: numero(p.total, 'total de ' + id, { min: -1e7, max: 1e8 }),
      mediana: numero(p.mediana, 'mediana de ' + id, { min: -1e7, max: 1e8, nulo: true }),
      max: numero(p.max, 'maior ato de ' + id, { min: -1e7, max: 1e8, nulo: true }),
      dias: numero(p.dias, 'dias de ' + id, { inteiro: true, max: 31, nulo: true })
    };
  });
  const pgto = (Array.isArray(d.pgto) ? d.pgto : []).slice(0, LIM.pgto).map(x => ({
    forma: txt(x && x.forma, 60) || 'Sem forma informada',
    qtd: numero(x.qtd, 'quantidade da forma de pagamento', { inteiro: true, max: 1e6 }),
    total: numero(x.total, 'total da forma de pagamento', { min: -1e7, max: 1e8 })
  }));
  let faixas = null;
  if (Array.isArray(d.faixas)) {
    faixas = d.faixas.slice(0, FAIXAS.length).map((x, i) => ({
      faixa: FAIXAS[i], qtd: numero(x && x.qtd, 'faixa', { inteiro: true, max: 1e6 }), total: numero(x.total, 'faixa', { min: -1e7, max: 1e8 })
    }));
    if (faixas.length !== FAIXAS.length) throw erro400('faixas de valor incompletas');
  }
  let serie = null;
  if (d.serie && Array.isArray(d.serie.dias) && d.serie.dias.length) {
    const dias = d.serie.dias.slice(0, LIM.dias + 1);
    if (dias.length > LIM.dias) throw erro400('dias demais na série');
    dias.forEach(x => { if (!RE_DIA.test(String(x))) throw erro400('dia inválido na série'); });
    const n = dias.length;
    const vetor = (v, rot) => {
      if (!Array.isArray(v) || v.length !== n) throw erro400('série ' + rot + ' com tamanho errado');
      return v.map(x => numero(x, 'valor da série', { min: -1e7, max: 1e8 }));
    };
    const porPessoa = {};
    Object.keys(d.serie.porPessoa || {}).forEach(id => { if (ids.has(id)) porPessoa[id] = vetor(d.serie.porPessoa[id], id); });
    serie = { dias: dias.map(String), total: vetor(d.serie.total, 'total'), porPessoa };
  }
  return {
    v: 1,
    formato: txt(d.formato, 30) || 'planilha',
    arquivo: txt(d.arquivo, 120) || null,
    total: numero(d.total, 'total do mês', { min: -1e7, max: 1e9 }),
    atos: numero(d.atos, 'atos do mês', { inteiro: true, max: 1e7 }),
    mediana: numero(d.mediana, 'mediana do mês', { min: -1e7, max: 1e8, nulo: true }),
    diasUteis: numero(d.diasUteis, 'dias úteis', { inteiro: true, min: 1, max: 31 }),
    pessoas: P, pgto, faixas, serie
  };
}
function lerMes(b) {
  const ano = numero(b.ano, 'ano', { inteiro: true, min: 2000, max: 2100 });
  const mes = numero(b.mes, 'mês', { inteiro: true, min: 1, max: 12 });
  return { ano, mes, chave: ano + '-' + String(mes).padStart(2, '0') };
}

// ---------------------------------------------------------------- dias úteis
function diasUteisDoMes(ym) {
  let n = 0;
  for (let d = ym + '-01'; d.slice(0, 7) === ym; d = cal.somaDias(d, 1)) if (cal.ehDiaUtil(d)) n++;
  return n;
}

// ---------------------------------------------------------------- IA
function ehTabeliao(id) { return require('./relatorios').admins().includes(String(id).toLowerCase()); }
const ehSistema = s => /n[ãa]o utilizar|sistema|extradigital/i.test(String(s));
function perfilDe(p, corte) {
  if (ehSistema(p.id) || ehSistema(p.nome || '')) return 'sistema';
  if (ehTabeliao(p.id)) return 'tabelião';
  return p.atos && p.total / p.atos >= corte ? 'mesa de escrituras' : 'balcão';
}
// O pacote que a IA lê: só números somados e o nome de exibição da equipe.
function resumoParaIA(m, anterior, nomes, cfg) {
  const d = m.dados, r2 = v => Math.round(v * 100) / 100;
  const pessoa = p => ({
    id: p.id, nome: nomes[p.id.toLowerCase()] || p.nome || p.id, perfil: perfilDe(p, cfg.corte),
    atos: p.atos, total: r2(p.total), ticket: p.atos ? r2(p.total / p.atos) : 0, mediana: p.mediana, maior_ato: p.max,
    share_receita_pct: d.total ? r2(p.total / d.total * 100) : 0, share_atos_pct: d.atos ? r2(p.atos / d.atos * 100) : 0,
    dias_com_lancamento: p.dias
  });
  const out = {
    mes: m.chave, dias_uteis: d.diasUteis, total: d.total, atos: d.atos, mediana: d.mediana,
    corte_mesa_ticket: cfg.corte, pessoas: d.pessoas.map(pessoa),
    formas_de_pagamento: d.pgto, faixas_de_valor: d.faixas,
    nota: 'forma de pagamento vazia não significa necessariamente pendência: escrituras costumam ser pagas por guia, depósito ou baixa posterior'
  };
  if (d.serie) {
    const dias = d.serie.dias.map((x, i) => ({ dia: x, total: d.serie.total[i] }));
    out.dias = dias;
    out.dias_uteis_sem_lancamento_por_pessoa = {};
    Object.keys(d.serie.porPessoa).forEach(id => {
      const zeros = d.serie.porPessoa[id].map((v, i) => v ? null : d.serie.dias[i]).filter(Boolean);
      if (zeros.length) out.dias_uteis_sem_lancamento_por_pessoa[id] = zeros;
    });
  }
  if (anterior) {
    out.mes_anterior = {
      mes: anterior.chave, total: anterior.dados.total, atos: anterior.dados.atos, dias_uteis: anterior.dados.diasUteis,
      pessoas: anterior.dados.pessoas.map(p => ({ id: p.id, atos: p.atos, total: p.total }))
    };
  }
  return out;
}
const PROMPT_IA = [
  'Você é o analista de gestão do Cartório de Notas do 2º Ofício de Itabaiana/SE (CN2O) e escreve para o Tabelião.',
  'Recebe os números de produtividade de UM mês (valores em reais, já somados por escrevente) e, quando houver, os do mês anterior.',
  'Perfis: "mesa de escrituras" (poucos atos de alto valor), "balcão" (muitos atos de valor baixo, reconhecimentos e autenticações), "tabelião" e "sistema" (lançamento técnico, sem pessoa).',
  'Regras:',
  '- Use só os números recebidos. Não invente causas: quando sugerir um motivo, diga que é hipótese a conferir.',
  '- Compare cada pessoa com quem tem o mesmo perfil, nunca mesa com balcão.',
  '- Português do Brasil, tom profissional e respeitoso, frases curtas. Valores no formato R$ 1.234,56.',
  '- "Fora do padrão" é o que merece conferência: queda ou alta brusca frente ao mês anterior, pessoa sem lançamento em dias úteis, lançamento de sistema, forma de pagamento vazia com valor alto, ato único muito acima do habitual, dia com faturamento zerado.',
  'Responda SÓ com um JSON neste formato, sem texto fora dele:',
  '{"resumo":"3 a 5 frases sobre o mês",',
  ' "pessoas":[{"id":"o id recebido","texto":"2 a 4 frases sobre a pessoa"}],',
  ' "observacoes":["até 6 observações de gestão, uma frase cada"],',
  ' "alertas":[{"titulo":"curto","detalhe":"1 a 2 frases","nivel":"atencao ou info"}]}'
].join('\n');
function limparAnalise(j, ids) {
  const s = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, n);
  if (!j || typeof j !== 'object') throw new Error('a IA não devolveu a análise no formato esperado');
  return {
    resumo: s(j.resumo, 2000),
    pessoas: (Array.isArray(j.pessoas) ? j.pessoas : []).filter(p => p && ids.has(String(p.id))).slice(0, LIM.pessoas)
      .map(p => ({ id: String(p.id), texto: s(p.texto, 1200) })),
    observacoes: (Array.isArray(j.observacoes) ? j.observacoes : []).slice(0, 8).map(x => s(x, 500)).filter(Boolean),
    alertas: (Array.isArray(j.alertas) ? j.alertas : []).slice(0, 10).map(a => ({
      titulo: s(a && a.titulo, 120), detalhe: s(a && a.detalhe, 600), nivel: a && a.nivel === 'atencao' ? 'atencao' : 'info'
    })).filter(a => a.titulo)
  };
}
async function analisar(m, anterior, login) {
  const gemini = require('./gemini');
  const defesa = require('./ia-defesa');
  const nomes = await nomesDaEquipe();
  const cfg = await lerConfig();
  const codigo = defesa.novoCodigo();
  const pacote = resumoParaIA(m, anterior, nomes, cfg);
  const modelo = gemini.MODELO_UNICO;   // v1.40.1: modelo único (gemini-3.8-flash)
  const r = await gemini.executar({
    agente: { prompt_sistema: PROMPT_IA, temperatura: 0.2 },
    observacoes: defesa.blocoDados('NÚMEROS DO MÊS', JSON.stringify(pacote, null, 1), codigo),
    modelo, codigo
  });
  try {
    require('./db-agentes').registrarConsumo({ minuta_id: null, usuario: login, agente: 'hub-produtividade', etapa: 'hub', uso: r.uso })
      .catch(e => console.error('produtividade consumo:', e.message));
  } catch (e) { console.error('produtividade consumo:', e.message); }
  const s = String(r.texto || '').replace(/```[a-zA-Z]*/g, '');
  let j = null;
  try { j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch (_) { j = null; }
  const a = limparAnalise(j, new Set(m.dados.pessoas.map(p => p.id)));
  a.modelo = r.uso && r.uso.modelo || modelo;
  a.custo_usd = r.uso && r.uso.custo_usd || 0;
  a.comparado_com = anterior ? anterior.chave : null;
  return a;
}

// ---------------------------------------------------------------- leitura
async function nomesDaEquipe() {
  const r = await q('SELECT login, nome FROM usuarios');
  const m = {};
  r.rows.forEach(x => { m[String(x.login).toLowerCase()] = x.nome; });
  return m;
}
function linhaMes(x) {
  return {
    ano: x.ano, mes: x.mes, chave: x.ano + '-' + String(x.mes).padStart(2, '0'),
    dados: x.dados, fonte: x.fonte, importado_por: x.importado_por, importado_em: x.importado_em,
    analise: x.analise, analise_em: x.analise_em
  };
}
async function lerMeses() {
  const r = await q('SELECT * FROM produtividade_mes ORDER BY ano, mes');
  return r.rows.map(linhaMes);
}

// ---------------------------------------------------------------- rotas
const router = express.Router();
const json = express.json({ limit: '512kb' });
const auditar = (req, detalhe) => require('./hub').auditar(req, 'admin', 'relatorios', detalhe);
const falha = (res, e) => {
  if (!e.status) console.error('[produtividade]', e.message);
  res.status(e.status || 500).json({ erro: e.status ? e.message : 'falha interna — tente de novo' });
};

router.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const [meses, config, nomes] = await Promise.all([lerMeses(), lerConfig(), nomesDaEquipe()]);
    res.json({ meses, config, nomes, tabeliaes: require('./relatorios').admins() });
  } catch (e) { falha(res, e); }
});

router.get('/dias-uteis', (req, res) => {
  const ym = String(req.query.mes || '');
  if (!RE_MES.test(ym)) return res.status(400).json({ erro: 'mes deve ser AAAA-MM' });
  res.json({ mes: ym, dias_uteis: diasUteisDoMes(ym) });
});

router.post('/mes', json, async (req, res) => {
  try {
    const b = req.body || {};
    const m = lerMes(b);
    const dados = validarDados(b.dados);
    const fonte = txt(b.fonte, 160) || ('Pesquisa de Produtividade · ' + m.chave);
    await q(`INSERT INTO produtividade_mes (ano, mes, dados, fonte, importado_por, importado_em, analise, analise_em)
             VALUES ($1, $2, $3, $4, $5, now(), NULL, NULL)
             ON CONFLICT (ano, mes) DO UPDATE SET dados = EXCLUDED.dados, fonte = EXCLUDED.fonte,
               importado_por = EXCLUDED.importado_por, importado_em = now(), analise = NULL, analise_em = NULL`,
    [m.ano, m.mes, JSON.stringify(dados), fonte, req.usuario.login]);
    auditar(req, `produtividade: importou ${m.chave} (${dados.atos} atos)`);
    res.json({ ok: true, chave: m.chave });
  } catch (e) { falha(res, e); }
});

router.post('/apagar', json, async (req, res) => {
  try {
    const m = lerMes(req.body || {});
    const r = await q('DELETE FROM produtividade_mes WHERE ano = $1 AND mes = $2 RETURNING ano', [m.ano, m.mes]);
    if (!r.rows.length) return res.status(404).json({ erro: 'mês não encontrado' });
    auditar(req, `produtividade: apagou ${m.chave}`);
    res.json({ ok: true });
  } catch (e) { falha(res, e); }
});

router.post('/config', json, async (req, res) => {
  try {
    const b = req.body || {};
    const cfg = {
      corte: numero(b.corte, 'corte da mesa', { min: 1, max: 100000 }),
      ferd: numero(b.ferd, 'percentual do FERD', { min: 0, max: 100 }),
      ir: numero(b.ir, 'percentual do IR', { min: 0, max: 100 })
    };
    await q(`INSERT INTO produtividade_config (chave, valor) VALUES ('geral', $1)
             ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`, [JSON.stringify(cfg)]);
    auditar(req, `produtividade: configuração (mesa ≥ R$ ${cfg.corte}, FERD ${cfg.ferd}%, IR ${cfg.ir}%)`);
    res.json({ ok: true, config: cfg });
  } catch (e) { falha(res, e); }
});

router.post('/analisar', json, async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ erro: 'a IA ainda não está configurada no servidor' });
  const { aguardarLimite, tetoDiario, MSG_TETO } = require('./limite-ia');
  try {
    const alvo = lerMes(req.body || {});
    const espera = aguardarLimite(req.usuario.login);
    if (espera) return res.status(429).json({ erro: 'muitas análises seguidas — aguarde um pouco e tente de novo', tente_em_s: espera });
    const teto = await tetoDiario(req.usuario.login).catch(() => null);
    if (teto && teto.excedido) return res.status(429).json({ erro: MSG_TETO(teto), motivo: 'teto' });
    const meses = await lerMeses();
    const i = meses.findIndex(x => x.chave === alvo.chave);
    if (i < 0) return res.status(404).json({ erro: 'mês não encontrado' });
    const a = await analisar(meses[i], i > 0 ? meses[i - 1] : null, req.usuario.login);
    await q('UPDATE produtividade_mes SET analise = $3, analise_em = now() WHERE ano = $1 AND mes = $2', [alvo.ano, alvo.mes, JSON.stringify(a)]);
    auditar(req, `produtividade: análise da IA de ${alvo.chave}`);
    res.json({ ok: true, analise: a });
  } catch (e) {
    if (e.status) return falha(res, e);
    console.error('[produtividade] IA:', e.message);
    res.status(502).json({ erro: 'a IA não conseguiu concluir a análise — tente de novo em instantes' });
  }
});

module.exports = { router, init, validarDados, diasUteisDoMes, resumoParaIA, limparAnalise, perfilDe, CONFIG_PADRAO, FAIXAS };
