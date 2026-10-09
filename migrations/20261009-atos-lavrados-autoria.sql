CREATE TABLE IF NOT EXISTS atos_lavrados_autorias (
  documento TEXT NOT NULL, minuta TEXT NOT NULL, revisao INTEGER NOT NULL,
  situacao TEXT NOT NULL CHECK (situacao IN ('confirmada','revogada')),
  colaborador_id TEXT, colaborador_nome TEXT, marco TEXT,
  evidencia JSONB NOT NULL, confirmado_por TEXT NOT NULL,
  confirmado_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (documento,minuta),
  CHECK (situacao='revogada' OR (colaborador_id IS NOT NULL AND colaborador_nome IS NOT NULL AND marco IN ('lavratura','registro')))
);
CREATE TABLE IF NOT EXISTS atos_lavrados_autoria_historico (
  documento TEXT NOT NULL, minuta TEXT NOT NULL, revisao INTEGER NOT NULL,
  situacao TEXT NOT NULL, colaborador_id TEXT, colaborador_nome TEXT, marco TEXT,
  evidencia JSONB NOT NULL, confirmado_por TEXT NOT NULL,
  confirmado_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (documento,minuta,revisao)
);
