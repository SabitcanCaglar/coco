-- pgvector extension for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- task queue
CREATE TABLE IF NOT EXISTS tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|assigned|running|done|failed
  priority    INTEGER NOT NULL DEFAULT 5,
  worker_id   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

-- examination results
CREATE TABLE IF NOT EXISTS examinations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_path  TEXT NOT NULL,
  examined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  health_score  INTEGER,
  grade         CHAR(1),
  triage        JSONB,
  vitals        JSONB,
  diagnosis     JSONB,
  treatment     JSONB,
  llm_used      TEXT,
  duration_ms   INTEGER
);

-- findings with embeddings for semantic search
CREATE TABLE IF NOT EXISTS findings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  examination_id UUID REFERENCES examinations(id) ON DELETE CASCADE,
  category       TEXT NOT NULL,
  severity       TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT,
  file_path      TEXT,
  line_start     INTEGER,
  line_end        INTEGER,
  embedding      vector(768)   -- nomic-embed-text dimension
);

-- worker registry
CREATE TABLE IF NOT EXISTS workers (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'idle',  -- idle|busy|offline
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status, priority DESC);
CREATE INDEX IF NOT EXISTS findings_examination_idx ON findings(examination_id);
CREATE INDEX IF NOT EXISTS findings_embedding_idx ON findings USING ivfflat (embedding vector_cosine_ops);
