-- O HTML original nunca e publicado como arquivo estatico nem executado no servidor.
CREATE TABLE IF NOT EXISTS gestao_relatorios (
  chave TEXT PRIMARY KEY,
  html BYTEA NOT NULL CHECK (octet_length(html) BETWEEN 1 AND 2097152),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  meses JSONB CHECK (meses IS NULL OR jsonb_typeof(meses) = 'object'),
  revisao INTEGER NOT NULL CHECK (revisao > 0),
  atualizado_por TEXT NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS gestao_relatorio_originais (
  chave TEXT NOT NULL REFERENCES gestao_relatorios(chave),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  html BYTEA NOT NULL CHECK (octet_length(html) BETWEEN 1 AND 2097152),
  criado_por TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (chave, sha256)
);
CREATE TABLE IF NOT EXISTS gestao_relatorio_estados (
  chave TEXT NOT NULL REFERENCES gestao_relatorios(chave),
  revisao INTEGER NOT NULL CHECK (revisao > 0),
  html_sha256 TEXT NOT NULL,
  meses JSONB CHECK (meses IS NULL OR jsonb_typeof(meses) = 'object'),
  origem TEXT NOT NULL CHECK (origem IN ('importacao', 'edicao')),
  criado_por TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (chave, revisao),
  FOREIGN KEY (chave, html_sha256) REFERENCES gestao_relatorio_originais(chave, sha256)
);
