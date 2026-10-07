-- Arquivo pessoal de trabalhos ITCMD. Sem expurgo: os dados e os PDFs de cada
-- versão permanecem disponíveis para retomada e reimpressão.
CREATE TABLE IF NOT EXISTS itcmd_trabalhos (
  id UUID PRIMARY KEY,
  criado_por TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  titulo TEXT NOT NULL CHECK (char_length(titulo) BETWEEN 1 AND 160),
  protocolo TEXT NOT NULL DEFAULT '' CHECK (char_length(protocolo) <= 40),
  versao INTEGER NOT NULL CHECK (versao > 0),
  atualizado_por TEXT NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS itcmd_trabalhos_dono_data ON itcmd_trabalhos(criado_por, atualizado_em DESC, id);
CREATE TABLE IF NOT EXISTS itcmd_trabalho_versoes (
  trabalho_id UUID NOT NULL REFERENCES itcmd_trabalhos(id),
  versao INTEGER NOT NULL CHECK (versao > 0),
  titulo TEXT NOT NULL,
  protocolo TEXT NOT NULL DEFAULT '',
  estado JSONB NOT NULL CHECK (jsonb_typeof(estado) = 'object'),
  criado_por TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  operacao_id UUID NOT NULL,
  pedido_sha256 TEXT NOT NULL CHECK (char_length(pedido_sha256) = 64),
  PRIMARY KEY (trabalho_id, versao),
  UNIQUE (criado_por, operacao_id)
);
CREATE TABLE IF NOT EXISTS itcmd_documentos (
  id UUID PRIMARY KEY,
  trabalho_id UUID NOT NULL,
  versao INTEGER NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('orcamento', 'declaracao_causa_mortis', 'declaracao_inter_vivos', 'guia_itcmd')),
  nome TEXT NOT NULL,
  mime TEXT NOT NULL CHECK (mime = 'application/pdf'),
  dados BYTEA NOT NULL CHECK (octet_length(dados) BETWEEN 1 AND 5242880),
  bytes INTEGER NOT NULL CHECK (bytes = octet_length(dados)),
  sha256 TEXT NOT NULL CHECK (char_length(sha256) = 64),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (trabalho_id, versao) REFERENCES itcmd_trabalho_versoes(trabalho_id, versao)
);
CREATE INDEX IF NOT EXISTS itcmd_documentos_trabalho_versao ON itcmd_documentos(trabalho_id, versao, criado_em, id);
