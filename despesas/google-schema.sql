CREATE TABLE IF NOT EXISTS despesas_google_connection (
 id integer PRIMARY KEY CHECK(id=1),
 credentials jsonb NOT NULL DEFAULT '{}',
 account text,
 folder_id text, folder_url text, spreadsheet_id text, spreadsheet_url text,
 last_sync timestamptz, last_error text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS despesas_google_oauth (
 state_hash text PRIMARY KEY, verifier text NOT NULL,
 client_id text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS despesas_google_files (
 document_id uuid PRIMARY KEY REFERENCES despesas_documents(id),
 file_id text NOT NULL, url text NOT NULL
);
CREATE TABLE IF NOT EXISTS despesas_google_jobs (
 entity text NOT NULL CHECK(entity IN ('document','entry')),
 record_id uuid NOT NULL, generation bigint NOT NULL DEFAULT 1,
 attempts integer NOT NULL DEFAULT 0, next_attempt timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(entity,record_id)
);
CREATE OR REPLACE FUNCTION despesas_google_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text;
BEGIN
 IF TG_TABLE_NAME='despesas_documents' THEN
  IF NEW.state<>'complete' THEN RETURN NEW; END IF;
  kind:='document';
 ELSE kind:='entry'; END IF;
 INSERT INTO despesas_google_jobs(entity,record_id) VALUES(kind,NEW.id)
 ON CONFLICT(entity,record_id) DO UPDATE SET generation=despesas_google_jobs.generation+1,attempts=0,next_attempt=now();
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS despesas_google_document_job ON despesas_documents;
CREATE TRIGGER despesas_google_document_job AFTER INSERT OR UPDATE ON despesas_documents FOR EACH ROW EXECUTE FUNCTION despesas_google_enqueue();
DROP TRIGGER IF EXISTS despesas_google_entry_job ON despesas_entries;
CREATE TRIGGER despesas_google_entry_job AFTER INSERT OR UPDATE ON despesas_entries FOR EACH ROW EXECUTE FUNCTION despesas_google_enqueue();
