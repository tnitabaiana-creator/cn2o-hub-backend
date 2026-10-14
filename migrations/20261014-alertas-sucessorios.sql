-- Controle interno anterior à numeração. Nenhuma alteração nos protocolos existentes.
CREATE TABLE IF NOT EXISTS sucessao_alertas (
  id UUID PRIMARY KEY,
  dados JSONB NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  revisao INTEGER NOT NULL DEFAULT 1,
  criado_por TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sucessao_documentos (
  id UUID PRIMARY KEY,
  alerta_id UUID NOT NULL REFERENCES sucessao_alertas(id),
  nome TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  arquivo BYTEA NOT NULL,
  criado_por TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(alerta_id, sha256)
);
CREATE TABLE IF NOT EXISTS sucessao_revisoes (
  id UUID PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  solicitante TEXT NOT NULL,
  payload JSONB NOT NULL,
  correspondencias JSONB NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendente' CHECK (estado IN ('pendente','conferido','liberado','obstado','homonimo')),
  conferencia JSONB NOT NULL DEFAULT '{}',
  fundamento TEXT,
  decidido_por TEXT,
  decidido_em TIMESTAMPTZ,
  protocolo INTEGER REFERENCES protocolos(numero),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sucessao_revisoes_busca ON sucessao_revisoes(solicitante, fingerprint);
CREATE TABLE IF NOT EXISTS sucessao_eventos (
  id BIGSERIAL PRIMARY KEY,
  entidade UUID NOT NULL,
  acao TEXT NOT NULL,
  autor TEXT NOT NULL,
  dados JSONB NOT NULL,
  em TIMESTAMPTZ NOT NULL DEFAULT now()
);
