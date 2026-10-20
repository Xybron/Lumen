#!/bin/sh
set -eu

# Executed by the official Postgres entrypoint only for a new evaluation volume.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --set=replication_password="$PS_REPLICATION_PASSWORD" \
  --set=storage_password="$PS_STORAGE_PASSWORD" \
  --file=/bootstrap/init-db.sql
