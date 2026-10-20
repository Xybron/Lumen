-- Synthetic local evaluation only. Never run this file against LAB.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE TABLE public.demo_cues (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.demo_cues ENABLE ROW LEVEL SECURITY;
-- No ordinary-user policies or grants. The read-only replication role bypasses
-- RLS to ingest allowed tables; the sync query enforces per-client isolation.
REVOKE ALL ON public.demo_cues FROM PUBLIC;

INSERT INTO public.demo_cues (id, owner_id, title, body) VALUES
  ('11111111-1111-4111-8111-111111111101', '11111111-1111-4111-8111-111111111111', 'Operator A demo cue', 'Synthetic Scripture operator draft.'),
  ('22222222-2222-4222-8222-222222222202', '22222222-2222-4222-8222-222222222222', 'Operator B demo cue', 'Synthetic presentation operator draft.');

CREATE ROLE lumen_replica WITH LOGIN REPLICATION BYPASSRLS PASSWORD :'replication_password';
GRANT CONNECT ON DATABASE lumen_demo TO lumen_replica;
GRANT USAGE ON SCHEMA public TO lumen_replica;
GRANT SELECT ON public.demo_cues TO lumen_replica;
CREATE PUBLICATION powersync FOR TABLE public.demo_cues;

-- Bucket writes cannot alter source rows. The storage role owns only its DB.
CREATE ROLE lumen_bucket WITH LOGIN PASSWORD :'storage_password';
CREATE DATABASE lumen_buckets OWNER lumen_bucket;
REVOKE ALL ON DATABASE lumen_buckets FROM PUBLIC;
GRANT CONNECT, CREATE ON DATABASE lumen_buckets TO lumen_bucket;
