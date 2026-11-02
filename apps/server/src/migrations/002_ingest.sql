-- WP 3.2–3.4: resumable uploads, upload batches (ingests) and the job queue.

-- One tus upload = one file. Bytes live on disk; this row tracks the offset.
CREATE TABLE uploads (
  id          text PRIMARY KEY,
  ingest_id   text NOT NULL,
  path        text NOT NULL,
  length      bigint NOT NULL,
  "offset"    bigint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ingest_id, path)
);

-- A set of files that becomes one model version: a GLB, a glTF folder, a 3D Tiles folder, a zip or an FBX.
CREATE TABLE ingests (
  id          text PRIMARY KEY,
  model_id    text REFERENCES models (id),
  version     integer,
  state       text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading', 'queued', 'checking', 'converting', 'ready', 'failed')),
  request     jsonb NOT NULL DEFAULT '{}'::jsonb,
  report      jsonb,
  error       text,
  ip          text NOT NULL DEFAULT '',
  host        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Postgres job queue. A worker leases a job; if it dies, the lease runs out and another worker takes the job.
CREATE TABLE jobs (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL,
  payload       jsonb NOT NULL,
  state         text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed')),
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 3,
  lease_until   timestamptz,
  run_after     timestamptz NOT NULL DEFAULT now(),
  progress      jsonb NOT NULL DEFAULT '{}'::jsonb,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready ON jobs (run_after) WHERE state IN ('queued', 'running');

ALTER TABLE versions ADD COLUMN report jsonb;
