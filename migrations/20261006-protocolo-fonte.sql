-- Migração aditiva e idempotente; executada no boot, depois de db-agentes.init.
-- Não altera protocolos antigos nem gera efeitos em Trello/IA.
CREATE TABLE IF NOT EXISTS protocolo_fonte_revisoes (
  numero INTEGER NOT NULL REFERENCES protocolos(numero),
  sha256 TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  autor TEXT,
  em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (numero,sha256)
);
CREATE TABLE IF NOT EXISTS protocolo_fonte_sync (
  numero INTEGER PRIMARY KEY REFERENCES protocolos(numero),
  sha256 TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendente',
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS protocolo_fonte_geracoes (
  id UUID PRIMARY KEY,
  usuario TEXT NOT NULL,
  ferramenta TEXT NOT NULL,
  protocolo INTEGER REFERENCES protocolos(numero),
  fonte_snapshot JSONB,
  conferencia JSONB NOT NULL DEFAULT '[]'::jsonb,
  manifestos JSONB NOT NULL DEFAULT '[]'::jsonb,
  texto_sha256 TEXT NOT NULL,
  em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS protocolo_fonte_geracoes_usuario_idx ON protocolo_fonte_geracoes(usuario,em);
ALTER TABLE minutas ADD COLUMN IF NOT EXISTS fonte_snapshot JSONB;
ALTER TABLE minutas ADD COLUMN IF NOT EXISTS fonte_conferencia JSONB;
ALTER TABLE minutas ADD COLUMN IF NOT EXISTS fonte_manifestos JSONB;
