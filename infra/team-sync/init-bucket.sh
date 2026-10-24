#!/bin/sh
set -eu

# The official Postgres entrypoint sources this container-local script on first
# initialization only. It never executes a host bind-mounted script directly.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 --set=bucket_password="$PS_BUCKET_PASSWORD" <<'SQL'
CREATE ROLE lumen_bucket LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'bucket_password';
ALTER DATABASE lumen_buckets OWNER TO lumen_bucket;
REVOKE ALL ON DATABASE lumen_buckets FROM PUBLIC;
GRANT CONNECT, CREATE ON DATABASE lumen_buckets TO lumen_bucket;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
