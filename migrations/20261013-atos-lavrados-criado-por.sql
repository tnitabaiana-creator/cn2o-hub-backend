-- CHECK cumulativo: preserva todas as evidências anteriores, sem modificar linhas.
ALTER TABLE atos_lavrados_autorias DROP CONSTRAINT IF EXISTS atos_lavrados_autorias_check;
ALTER TABLE atos_lavrados_autorias DROP CONSTRAINT IF EXISTS atos_lavrados_autorias_marco_check;
ALTER TABLE atos_lavrados_autorias ADD CONSTRAINT atos_lavrados_autorias_marco_check CHECK (
  situacao='revogada' OR (
    colaborador_id IS NOT NULL AND colaborador_nome IS NOT NULL AND (
      (marco IN ('lavratura','registro') AND evidencia->>'tipo'='registro_lavratura_extra') OR
      (marco='atribuicao_gerencial' AND evidencia->>'tipo'='auditoria_trello_criterio_titular'
       AND evidencia->>'metodo' IN ('auditoria_concordante','trello_divergencia')
       AND evidencia->>'sha256_calculado' ~ '^[a-f0-9]{64}$') OR
      (marco='atribuicao_gerencial' AND evidencia->>'tipo'='trello_movimentacao_arquivo_criterio_titular'
       AND evidencia->>'metodo' IN ('movimentacao_arquivo_trello','ultimo_escrevente_antes_arquivo_trello')
       AND evidencia->>'sha256_calculado' ~ '^[a-f0-9]{64}$'
       AND evidencia#>>'{trello,cartao_id}' ~ '^[a-f0-9]{24}$'
       AND evidencia#>>'{decisao,cartao_id}' = evidencia#>>'{trello,cartao_id}') OR
      (marco='atribuicao_gerencial' AND evidencia->>'tipo'='criado_por_extra_criterio_titular'
       AND evidencia->>'metodo'='criado_por_extra'
       AND evidencia->>'sha256_calculado' ~ '^[a-f0-9]{64}$'
       AND evidencia#>>'{fonte,sha256}' ~ '^[a-f0-9]{64}$'
       AND evidencia#>>'{decisao,colaborador,id}'=colaborador_id
       AND evidencia#>>'{decisao,colaborador,papel}' IN ('escrevente','tabeliao'))
    ) IS TRUE
  )
);
