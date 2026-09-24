// db-relatorios.js — tabelas do rastreio do Trello e dos relatórios das escreventes (v1.38).
// Idempotente (CREATE … IF NOT EXISTS / ON CONFLICT DO NOTHING): roda em todo boot, depois
// do db.js e do db-agentes.js. Nenhum nome colide com as demais tabelas do hub.
//
//   escreventes       quem tem quadro próprio: login ↔ quadro ↔ lista "Finalizado"
//   eventos_trello    ações do Trello como chegaram (chave = id da ação → idempotência)
//   passagens         cada estada de um cartão numa lista, em horas úteis
//   pendencias        estadas em PENDÊNCIAS/AGUARDA (documental) e Ajuste/Retorno (ajuste)
//   conclusoes        um registro por cartão que chegou ao Finalizado de uma escrevente
//   pesos_ato         peso e referência de horas por tipo de ato (calibrável)
//   envios_relatorio  cada relatório enviado (trava contra envio em dobro)
'use strict';

const db = require('./db');
const { TIPOS } = require('./tipos-ato');

// Fase 0 (levantamento no Trello): quadro "02. ESCREVENTE …" e a lista Finalizado dele.
const ESCREVENTES = [
  ['camily.oliveira',  'Camily',   '692e084cec9c0b8b5eb304d3', '692e08ec2885fac3dba67943'],
  ['romenia.oliveira', 'Romênia',  '692e095e6ca879a15d5ee852', '692e09c59bb8dfc454cd3ebc'],
  ['lara.silva',       'Lara',     '692e0a12a6941ed8d023177f', '692e0a801cb3dafed4eb0127'],
  ['josi.silva',       'Josilene', '692e076f5485a0cbb533fe61', '692e07fa9964adfc05458df9'],
  ['jonas.aragao',     'Jonas',    '69ee446f4480af4b9688554a', '69ee457259d12d099da94d4f']
];

async function init() {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS escreventes (
      login               TEXT PRIMARY KEY,
      nome                TEXT NOT NULL,
      board_id            TEXT NOT NULL UNIQUE,
      list_finalizado_id  TEXT NOT NULL UNIQUE,
      email               TEXT,
      ativo               BOOLEAN NOT NULL DEFAULT true,
      criado_em           TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS eventos_trello (
      action_id     TEXT PRIMARY KEY,
      tipo          TEXT NOT NULL,
      card_id       TEXT NOT NULL,
      board_id      TEXT,
      ocorrido_em   TIMESTAMPTZ NOT NULL,
      origem        TEXT NOT NULL DEFAULT 'webhook',       -- webhook | carga
      dados         JSONB NOT NULL,                        -- action.data (sem o model)
      recebido_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
      processado_em TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS eventos_trello_card ON eventos_trello (card_id, ocorrido_em);
    CREATE INDEX IF NOT EXISTS eventos_trello_pendentes ON eventos_trello (card_id) WHERE processado_em IS NULL;
    CREATE TABLE IF NOT EXISTS passagens (
      id              BIGSERIAL PRIMARY KEY,
      card_id         TEXT NOT NULL,
      board_id        TEXT,
      list_id         TEXT,
      list_nome       TEXT,
      categoria       TEXT NOT NULL,
      escrevente      TEXT,                  -- dono do quadro (NULL nos quadros 00/01)
      entrou_em       TIMESTAMPTZ,           -- NULL = entrada anterior à carga
      saiu_em         TIMESTAMPTZ,           -- NULL = o cartão ainda está lá
      horas_uteis     DOUBLE PRECISION,
      action_entrada  TEXT NOT NULL,
      action_saida    TEXT,
      UNIQUE (card_id, action_entrada)
    );
    CREATE INDEX IF NOT EXISTS passagens_abertas ON passagens (escrevente) WHERE saiu_em IS NULL;
    CREATE INDEX IF NOT EXISTS passagens_entrada ON passagens (entrou_em);
    CREATE TABLE IF NOT EXISTS pendencias (
      id               BIGSERIAL PRIMARY KEY,
      card_id          TEXT NOT NULL,
      tipo             TEXT NOT NULL CHECK (tipo IN ('documental', 'ajuste')),
      escrevente       TEXT,                 -- responsável pelo cartão naquele momento
      board_id         TEXT,
      list_nome        TEXT,
      aberta_em        TIMESTAMPTZ,
      fechada_em       TIMESTAMPTZ,
      horas_uteis      DOUBLE PRECISION,
      action_abertura  TEXT NOT NULL,
      UNIQUE (card_id, action_abertura)
    );
    CREATE INDEX IF NOT EXISTS pendencias_periodo ON pendencias (aberta_em, fechada_em);
    CREATE TABLE IF NOT EXISTS conclusoes (
      card_id              TEXT PRIMARY KEY,
      escrevente           TEXT NOT NULL,
      protocolo            INTEGER,
      tipo_ato             TEXT NOT NULL,
      rotulo               TEXT,             -- texto entre parênteses do título, como veio
      card_short           TEXT,
      concluido_em         TIMESTAMPTZ NOT NULL,   -- 1ª chegada ao Finalizado
      ultima_conclusao_em  TIMESTAMPTZ NOT NULL,
      reaberturas          INTEGER NOT NULL DEFAULT 0,
      entrada_mesa_em      TIMESTAMPTZ,
      horas_mesa           DOUBLE PRECISION,       -- entrada no quadro → Finalizado
      horas_ativas         DOUBLE PRECISION,       -- custo pessoal
      horas_pendencia      DOUBLE PRECISION,
      horas_conferencia    DOUBLE PRECISION,
      horas_assinatura     DOUBLE PRECISION,
      retornos             INTEGER NOT NULL DEFAULT 0,
      historico_completo   BOOLEAN NOT NULL,
      atualizado_em        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS conclusoes_periodo ON conclusoes (concluido_em);
    CREATE TABLE IF NOT EXISTS pesos_ato (
      tipo_ato          TEXT PRIMARY KEY,
      descricao         TEXT NOT NULL,
      peso              DOUBLE PRECISION NOT NULL CHECK (peso > 0),
      horas_referencia  DOUBLE PRECISION NOT NULL CHECK (horas_referencia > 0),
      atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS envios_relatorio (
      id              BIGSERIAL PRIMARY KEY,
      tipo            TEXT NOT NULL CHECK (tipo IN ('semanal', 'mensal')),
      periodo_inicio  DATE NOT NULL,
      periodo_fim     DATE NOT NULL,
      manual          BOOLEAN NOT NULL DEFAULT false,
      status          TEXT NOT NULL CHECK (status IN ('enviando', 'enviado', 'erro')),
      tentativas      INTEGER NOT NULL DEFAULT 1,
      destinatarios   TEXT,
      erro            TEXT,
      resumo          JSONB,
      por             TEXT,
      criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
      enviado_em      TIMESTAMPTZ
    );
    -- um envio AUTOMÁTICO por tipo e período; os manuais (teste, reenvio) não travam
    CREATE UNIQUE INDEX IF NOT EXISTS envios_relatorio_auto ON envios_relatorio (tipo, periodo_inicio) WHERE NOT manual;
  `);
  for (const [login, nome, board, finalizado] of ESCREVENTES) {
    await db.pool.query(
      `INSERT INTO escreventes (login, nome, board_id, list_finalizado_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`, [login, nome, board, finalizado]);
  }
  for (const [tipo, [descricao, peso, horas]] of Object.entries(TIPOS)) {
    await db.pool.query(
      `INSERT INTO pesos_ato (tipo_ato, descricao, peso, horas_referencia) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tipo_ato) DO NOTHING`, [tipo, descricao, peso, horas]);
  }
}

module.exports = { init, ESCREVENTES };
