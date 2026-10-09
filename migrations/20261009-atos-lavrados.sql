CREATE TABLE IF NOT EXISTS atos_lavrados_lotes (
  id UUID PRIMARY KEY, sha256 TEXT NOT NULL, fonte JSONB NOT NULL,
  conteudo JSONB NOT NULL, criado_por TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS atos_lavrados_meses (
  mes TEXT PRIMARY KEY CHECK (mes ~ '^\d{4}-\d{2}$'), revisao INTEGER NOT NULL CHECK (revisao > 0)
);
CREATE TABLE IF NOT EXISTS atos_lavrados_versoes (
  mes TEXT NOT NULL, revisao INTEGER NOT NULL, ate DATE NOT NULL,
  lote_id UUID NOT NULL REFERENCES atos_lavrados_lotes(id), sha256 TEXT NOT NULL,
  total INTEGER NOT NULL, PRIMARY KEY (mes, revisao)
);
CREATE TABLE IF NOT EXISTS atos_lavrados_itens (
  mes TEXT NOT NULL, revisao INTEGER NOT NULL, chave TEXT NOT NULL,
  data_lavratura DATE NOT NULL, registro JSONB NOT NULL,
  PRIMARY KEY (mes, revisao, chave),
  FOREIGN KEY (mes, revisao) REFERENCES atos_lavrados_versoes(mes, revisao)
);
CREATE INDEX IF NOT EXISTS atos_lavrados_chave ON atos_lavrados_itens(chave);
CREATE UNIQUE INDEX IF NOT EXISTS atos_lavrados_identidade_versao ON atos_lavrados_itens(mes,revisao,(registro->>'documento'),(registro->>'minuta'));
CREATE INDEX IF NOT EXISTS atos_lavrados_identidade ON atos_lavrados_itens((registro->>'documento'),(registro->>'minuta'));
-- Ausência de metadados em versões anteriores nunca presume dia encerrado.
ALTER TABLE atos_lavrados_versoes ADD COLUMN IF NOT EXISTS corte_em TIMESTAMPTZ;
ALTER TABLE atos_lavrados_versoes ADD COLUMN IF NOT EXISTS dia_final_completo BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS atos_lavrados_vinculos (
  chave TEXT PRIMARY KEY, revisao INTEGER NOT NULL, protocolo_hub INTEGER NOT NULL,
  evidencia JSONB NOT NULL, criado_por TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS atos_lavrados_vinculo_historico (
  chave TEXT NOT NULL, revisao INTEGER NOT NULL, protocolo_hub INTEGER NOT NULL,
  evidencia JSONB NOT NULL, criado_por TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (chave, revisao)
);
