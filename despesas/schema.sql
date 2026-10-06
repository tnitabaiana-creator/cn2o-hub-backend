CREATE TABLE despesas_documents (
 id uuid PRIMARY KEY,
 hash text NOT NULL UNIQUE CHECK (hash ~ '^[a-f0-9]{64}$'),
 metadata jsonb NOT NULL,
 state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','complete')),
 ocr jsonb,
 version integer NOT NULL DEFAULT 1,
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE despesas_entries (
 id uuid PRIMARY KEY,
 data jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1,
 updated_by text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX despesas_duplicate_expense ON despesas_entries
 ((lower(trim(data->>'supplier'))), (data->>'paidDate'), ((data->>'cents')::bigint));
CREATE TABLE despesas_audit (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 record_id uuid NOT NULL,
 record_type text NOT NULL,
 version integer NOT NULL,
 actor text NOT NULL,
 at timestamptz NOT NULL DEFAULT now(),
 snapshot jsonb NOT NULL
);
CREATE INDEX despesas_audit_record ON despesas_audit(record_id,sequence);
CREATE FUNCTION despesas_record_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO despesas_audit(record_id,record_type,version,actor,snapshot)
 VALUES (NEW.id,'entry',NEW.version,NEW.updated_by,NEW.data);
 RETURN NEW;
END; $$;
CREATE TRIGGER despesas_entry_history AFTER INSERT OR UPDATE ON despesas_entries
 FOR EACH ROW EXECUTE FUNCTION despesas_record_audit();
CREATE TABLE despesas_ocr_usage (
 month date PRIMARY KEY,
 count integer NOT NULL DEFAULT 0
);

CREATE TABLE despesas_parts (
 document_id uuid NOT NULL REFERENCES despesas_documents(id),
 part integer NOT NULL CHECK (part >= 0),
 digest text NOT NULL,
 bytes bytea NOT NULL,
 PRIMARY KEY(document_id,part)
);
