// db-agentes.js — schema e consultas do módulo de agentes.
// Segue o padrão do db.js existente: pool único, CREATE TABLE IF NOT EXISTS
// idempotente no boot, ALTER TABLE ADD COLUMN IF NOT EXISTS para migração.

const { pool } = require('./db');

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agentes (
      slug             TEXT PRIMARY KEY,
      nome             TEXT NOT NULL,
      descricao        TEXT,
      categoria        TEXT NOT NULL DEFAULT 'escritura',
      codigo_ato       TEXT,
      ordem            INTEGER NOT NULL DEFAULT 100,
      modelo_extracao  TEXT,
      modelo_redacao   TEXT,
      prompt_sistema   TEXT NOT NULL,
      template         TEXT,
      campos           JSONB NOT NULL DEFAULT '[]'::jsonb,
      ativo            BOOLEAN NOT NULL DEFAULT true,
      versao           INTEGER NOT NULL DEFAULT 1,
      atualizado       TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_por   TEXT
    );

    -- usa_busca: liga a ferramenta de busca do Gemini para este agente. No app
    -- do Gemini o Gem pesquisa sozinho; pela API é preciso declarar.
    -- temperatura: 0 para transcrição literal, mais alto para redação.
    ALTER TABLE agentes ADD COLUMN IF NOT EXISTS usa_busca   BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE agentes ADD COLUMN IF NOT EXISTS temperatura NUMERIC(3,2);

    CREATE TABLE IF NOT EXISTS agente_versoes (
      id              SERIAL PRIMARY KEY,
      slug            TEXT NOT NULL,
      versao          INTEGER NOT NULL,
      prompt_sistema  TEXT,
      template        TEXT,
      campos          JSONB,
      criado          TIMESTAMPTZ NOT NULL DEFAULT now(),
      criado_por      TEXT
    );

    CREATE TABLE IF NOT EXISTS minutas (
      id          SERIAL PRIMARY KEY,
      protocolo   INTEGER,
      agente      TEXT NOT NULL,
      usuario     TEXT NOT NULL,
      titulo      TEXT,
      status      TEXT NOT NULL DEFAULT 'rascunho',
      dados       JSONB NOT NULL DEFAULT '{}'::jsonb,
      alertas     JSONB NOT NULL DEFAULT '[]'::jsonb,
      texto       TEXT,
      criado      TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS minuta_turnos (
      id         SERIAL PRIMARY KEY,
      minuta_id  INTEGER NOT NULL REFERENCES minutas(id) ON DELETE CASCADE,
      papel      TEXT NOT NULL,
      conteudo   TEXT NOT NULL,
      criado     TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS consumo (
      id              SERIAL PRIMARY KEY,
      minuta_id       INTEGER,
      usuario         TEXT,
      agente          TEXT,
      etapa           TEXT NOT NULL,
      modelo          TEXT NOT NULL,
      tokens_entrada  INTEGER NOT NULL DEFAULT 0,
      tokens_saida    INTEGER NOT NULL DEFAULT 0,
      custo_usd       NUMERIC(12,6) NOT NULL DEFAULT 0,
      criado          TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS minutas_usuario_idx  ON minutas (usuario, criado DESC);
    CREATE INDEX IF NOT EXISTS minutas_protocolo_idx ON minutas (protocolo);
    CREATE INDEX IF NOT EXISTS consumo_criado_idx   ON consumo (criado DESC);
  `);
}

// ------------------------------------------------------------------ AGENTES

async function listarAgentes(incluirInativos = false) {
  const { rows } = await pool.query(
    `SELECT slug, nome, descricao, categoria, codigo_ato, ordem, ativo, versao,
            jsonb_array_length(campos) AS qtd_campos,
            (template IS NOT NULL AND length(template) > 0) AS tem_template
       FROM agentes
      ${incluirInativos ? '' : 'WHERE ativo'}
      ORDER BY ordem, nome`
  );
  return rows;
}

async function obterAgente(slug) {
  const { rows } = await pool.query('SELECT * FROM agentes WHERE slug = $1', [slug]);
  return rows[0] || null;
}

async function salvarAgente(a, porQuem) {
  const { rows } = await pool.query(
    `INSERT INTO agentes
       (slug, nome, descricao, categoria, codigo_ato, ordem,
        modelo_extracao, modelo_redacao, prompt_sistema, template, campos,
        ativo, atualizado_por, usa_busca, temperatura)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,COALESCE($12,true),$13,
             COALESCE($14,false),$15)
     ON CONFLICT (slug) DO UPDATE SET
       nome            = EXCLUDED.nome,
       descricao       = EXCLUDED.descricao,
       categoria       = EXCLUDED.categoria,
       codigo_ato      = EXCLUDED.codigo_ato,
       ordem           = EXCLUDED.ordem,
       modelo_extracao = EXCLUDED.modelo_extracao,
       modelo_redacao  = EXCLUDED.modelo_redacao,
       prompt_sistema  = EXCLUDED.prompt_sistema,
       template        = EXCLUDED.template,
       campos          = EXCLUDED.campos,
       ativo           = EXCLUDED.ativo,
       usa_busca       = EXCLUDED.usa_busca,
       temperatura     = EXCLUDED.temperatura,
       versao          = agentes.versao + 1,
       atualizado      = now(),
       atualizado_por  = EXCLUDED.atualizado_por
     RETURNING *`,
    [a.slug, a.nome, a.descricao || null, a.categoria || 'escritura', a.codigo_ato || null,
     a.ordem == null ? 100 : a.ordem, a.modelo_extracao || null, a.modelo_redacao || null,
     a.prompt_sistema, a.template || null, JSON.stringify(a.campos || []),
     a.ativo, porQuem || null, a.usa_busca, a.temperatura == null ? null : a.temperatura]
  );
  const salvo = rows[0];
  // Histórico: toda gravação vira uma versão, para dar para voltar atrás.
  await pool.query(
    `INSERT INTO agente_versoes (slug, versao, prompt_sistema, template, campos, criado_por)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [salvo.slug, salvo.versao, salvo.prompt_sistema, salvo.template,
     JSON.stringify(salvo.campos || []), porQuem || null]
  );
  return salvo;
}

async function versoesDoAgente(slug) {
  const { rows } = await pool.query(
    `SELECT id, versao, criado, criado_por,
            length(prompt_sistema) AS tam_prompt,
            length(COALESCE(template,'')) AS tam_template
       FROM agente_versoes WHERE slug = $1 ORDER BY versao DESC LIMIT 50`,
    [slug]
  );
  return rows;
}

// ------------------------------------------------------------------ MINUTAS

async function criarMinuta({ protocolo, agente, usuario, titulo, dados, alertas }) {
  const { rows } = await pool.query(
    `INSERT INTO minutas (protocolo, agente, usuario, titulo, dados, alertas)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb) RETURNING *`,
    [protocolo || null, agente, usuario, titulo || null,
     JSON.stringify(dados || {}), JSON.stringify(alertas || [])]
  );
  return rows[0];
}

// As colunas que podem ser atualizadas ficam aqui dentro, e não na confiança de
// quem chama. O nome da coluna entra no SQL por interpolação — se um dia alguém
// passar as chaves de um req.body direto, a lista branca é o que impede injeção.
const COLUNAS_MINUTA = new Set(['protocolo', 'titulo', 'status', 'dados', 'alertas', 'texto']);
const COLUNAS_JSONB = new Set(['dados', 'alertas']);

async function atualizarMinuta(id, campos) {
  const set = [], vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(campos)) {
    if (!COLUNAS_MINUTA.has(k)) throw new Error(`campo não atualizável: ${k}`);
    if (COLUNAS_JSONB.has(k)) { set.push(`${k} = $${i}::jsonb`); vals.push(JSON.stringify(v)); }
    else { set.push(`${k} = $${i}`); vals.push(v); }
    i++;
  }
  if (!set.length) throw new Error('nada para atualizar');
  set.push('atualizado = now()');
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE minutas SET ${set.join(', ')} WHERE id = $${i} RETURNING *`, vals
  );
  return rows[0] || null;
}

async function obterMinuta(id) {
  const { rows } = await pool.query('SELECT * FROM minutas WHERE id = $1', [id]);
  if (!rows[0]) return null;
  const t = await pool.query(
    'SELECT papel, conteudo, criado FROM minuta_turnos WHERE minuta_id = $1 ORDER BY id', [id]
  );
  return { ...rows[0], turnos: t.rows };
}

async function listarMinutas({ usuario, todos, limite = 50 }) {
  const { rows } = await pool.query(
    `SELECT m.id, m.protocolo, m.agente, m.usuario, m.titulo, m.status,
            m.criado, m.atualizado, a.nome AS agente_nome,
            (m.texto IS NOT NULL) AS tem_texto,
            jsonb_array_length(m.alertas) AS qtd_alertas
       FROM minutas m LEFT JOIN agentes a ON a.slug = m.agente
      ${todos ? '' : 'WHERE m.usuario = $2'}
      ORDER BY m.atualizado DESC LIMIT $1`,
    todos ? [limite] : [limite, usuario]
  );
  return rows;
}

async function registrarTurno(minutaId, papel, conteudo) {
  await pool.query(
    'INSERT INTO minuta_turnos (minuta_id, papel, conteudo) VALUES ($1,$2,$3)',
    [minutaId, papel, conteudo]
  );
}

// ------------------------------------------------------------------ CONSUMO

async function registrarConsumo({ minuta_id, usuario, agente, etapa, uso }) {
  await pool.query(
    `INSERT INTO consumo (minuta_id, usuario, agente, etapa, modelo,
                          tokens_entrada, tokens_saida, custo_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [minuta_id || null, usuario || null, agente || null, etapa,
     uso.modelo, uso.tokens_entrada, uso.tokens_saida, uso.custo_usd]
  );
}

async function resumoConsumo(dias = 30) {
  const { rows } = await pool.query(
    `SELECT usuario, agente, etapa, modelo,
            COUNT(*)::int              AS chamadas,
            SUM(tokens_entrada)::bigint AS entrada,
            SUM(tokens_saida)::bigint   AS saida,
            ROUND(SUM(custo_usd)::numeric, 4) AS usd
       FROM consumo
      WHERE criado > now() - ($1 || ' days')::interval
      GROUP BY usuario, agente, etapa, modelo
      ORDER BY usd DESC`,
    [String(dias)]
  );
  const { rows: tot } = await pool.query(
    `SELECT COUNT(DISTINCT minuta_id)::int AS minutas,
            ROUND(SUM(custo_usd)::numeric, 4) AS usd
       FROM consumo WHERE criado > now() - ($1 || ' days')::interval`,
    [String(dias)]
  );
  return { linhas: rows, total: tot[0] || { minutas: 0, usd: 0 }, dias };
}

module.exports = {
  init, listarAgentes, obterAgente, salvarAgente, versoesDoAgente,
  criarMinuta, atualizarMinuta, obterMinuta, listarMinutas, registrarTurno,
  registrarConsumo, resumoConsumo
};
