-- WP 3.1: library, versions, layer manifests, classifications, audit, settings.

CREATE TABLE classifications (
  id          text PRIMARY KEY,
  label       text NOT NULL,
  color       text NOT NULL,
  text_color  text NOT NULL,
  ord         integer NOT NULL
);

CREATE TABLE models (
  id                  text PRIMARY KEY,
  name                text NOT NULL,
  project             text NOT NULL DEFAULT '',
  operation           text NOT NULL DEFAULT '',
  responsible_entity  text NOT NULL DEFAULT '',
  description         text NOT NULL DEFAULT '',
  status              text NOT NULL CHECK (status IN ('draft', 'inProduction', 'current', 'superseded')),
  status_changed_at   date NOT NULL DEFAULT CURRENT_DATE,
  classification_id   text NOT NULL REFERENCES classifications (id),
  source_format       text NOT NULL CHECK (source_format IN ('glb', 'gltf', 'fbx', '3dtiles')),
  centre_lat          double precision NOT NULL,
  centre_lon          double precision NOT NULL,
  current_version     integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
CREATE INDEX models_status ON models (status) WHERE deleted_at IS NULL;

CREATE TABLE versions (
  model_id    text NOT NULL REFERENCES models (id) ON DELETE CASCADE,
  version     integer NOT NULL,
  source      jsonb NOT NULL,
  placement   jsonb,
  size_bytes  bigint NOT NULL DEFAULT 0,
  state       text NOT NULL DEFAULT 'ready' CHECK (state IN ('uploading', 'checking', 'converting', 'ready', 'failed')),
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, version)
);

CREATE TABLE layer_manifests (
  model_id  text NOT NULL,
  version   integer NOT NULL,
  manifest  jsonb NOT NULL,
  PRIMARY KEY (model_id, version),
  FOREIGN KEY (model_id, version) REFERENCES versions (model_id, version) ON DELETE CASCADE
);

-- Append-only, hash-chained (WP 3.8). Rows are never updated or deleted by the application.
CREATE TABLE audit_events (
  seq        bigserial PRIMARY KEY,
  at         timestamptz NOT NULL,
  ip         text NOT NULL DEFAULT '',
  host       text NOT NULL DEFAULT '',
  action     text NOT NULL,
  target     text NOT NULL DEFAULT '',
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash  text NOT NULL,
  hash       text NOT NULL UNIQUE
);
CREATE INDEX audit_events_at ON audit_events (at);

CREATE TABLE settings (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);
