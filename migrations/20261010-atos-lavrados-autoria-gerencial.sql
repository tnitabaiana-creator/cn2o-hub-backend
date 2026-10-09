-- Evolução compatível: não reclassifica atribuições diretas nem altera histórico.
ALTER TABLE atos_lavrados_autorias DROP CONSTRAINT IF EXISTS atos_lavrados_autorias_check;
ALTER TABLE atos_lavrados_autorias DROP CONSTRAINT IF EXISTS atos_lavrados_autorias_marco_check;
ALTER TABLE atos_lavrados_autorias ADD CONSTRAINT atos_lavrados_autorias_marco_check CHECK (
  situacao='revogada' OR (
    colaborador_id IS NOT NULL AND colaborador_nome IS NOT NULL AND (
      (marco IN ('lavratura','registro') AND evidencia->>'tipo'='registro_lavratura_extra') OR
      (marco='atribuicao_gerencial' AND evidencia->>'tipo'='auditoria_trello_criterio_titular'
       AND evidencia->>'metodo' IN ('auditoria_concordante','trello_divergencia')
       AND evidencia->>'sha256_calculado' ~ '^[a-f0-9]{64}$')
    ) IS TRUE
  )
);
