CREATE TABLE IF NOT EXISTS livro_caixa_anexos (
 id UUID PRIMARY KEY,
 nome TEXT NOT NULL,
 tipo TEXT NOT NULL,
 bytes BYTEA NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 10485760),
 sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 criado_por TEXT NOT NULL,
 criado_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS livro_caixa_versoes (
 mes TEXT NOT NULL CHECK (mes ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
 revisao INTEGER NOT NULL CHECK (revisao > 0),
 total_despesas_centavos BIGINT NOT NULL CHECK (total_despesas_centavos BETWEEN 0 AND 100000000000),
 fonte TEXT NOT NULL,
 anexo_id UUID REFERENCES livro_caixa_anexos(id),
 receita_referencia JSONB,
 sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 atualizado_por TEXT NOT NULL,
 atualizado_em TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (mes,revisao)
);
CREATE TABLE IF NOT EXISTS livro_caixa_meses (
 mes TEXT PRIMARY KEY,
 revisao INTEGER NOT NULL,
 FOREIGN KEY (mes,revisao) REFERENCES livro_caixa_versoes(mes,revisao)
);
