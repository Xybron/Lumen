export async function openTeamDatabase(project: string, userId: string) {
  if (!/^[a-z0-9]+$/.test(project) || !/^[a-f0-9-]{36}$/.test(userId)) throw new Error('Invalid account database identity.');
  // Existing live/render surfaces do not pay for SQLite/WASM until a real team
  // account opens its preparation workspace.
  const { column, Schema, Table, PowerSyncDatabase, LogLevels } = await import('@powersync/web');
  const teamSchema = new Schema({
  lumen_teams: new Table({ name: column.text, created_by: column.text, created_at: column.text }),
  lumen_memberships: new Table({ team_id: column.text, user_id: column.text, role: column.text, created_at: column.text }),
  lumen_profiles: new Table({ display_name: column.text, updated_at: column.text }),
  lumen_resources: new Table({ team_id: column.text, kind: column.text, name: column.text, document: column.text, revision: column.integer, updated_by: column.text, updated_at: column.text }, { indexes: { team: ['team_id'] } }),
  // Separate local-only cache and CAS outbox: a failed/late checkpoint must never
  // erase an unacknowledged edit. These tables NEVER become sync streams.
  team_cache: new Table({ value: column.text }, { localOnly: true }),
  resource_cache: new Table({ team_id: column.text, value: column.text }, { localOnly: true }),
  edit_outbox: new Table({ team_id: column.text, resource_id: column.text, value: column.text, base_revision: column.integer, created_at: column.text }, { localOnly: true }),
  edit_conflicts: new Table({ team_id: column.text, value: column.text }, { localOnly: true }),
  });
  const db = new PowerSyncDatabase({ schema: teamSchema,
    database: { dbFilename: `lumen-team-${project}-${userId}.db`, cacheSizeKb: 4096, databaseWorkerLogLevel: LogLevels.error },
    sync: { logLevel: LogLevels.error }, broadcastLogs: false });
  await db.init();
  return db;
}
