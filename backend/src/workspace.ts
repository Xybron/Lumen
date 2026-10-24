import fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import type { StationWorkspace } from '../../shared/workspace.js';

// A team/workspace UUID is an immutable namespace, never a credential or proof
// that a browser account owns the corresponding cloud team.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIMIT = 2048;
type Identity = { version: 1; id: string; createdAt: string; mode: 'local' | 'provisioned' };
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const ownedPrivateFile = (stat: Stats) => stat.isFile() && stat.nlink === 1
  && (process.platform === 'win32' || (stat.mode & 0o077) === 0) && (!process.getuid || stat.uid === process.getuid());

export class WorkspaceIdentityError extends Error {
  constructor(message = 'The station workspace identity could not be verified safely. Existing files were preserved; check workspace.json and its permissions before starting this station.') { super(message); }
}

export function configuredWorkspaceId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.LUMEN_WORKSPACE_ID;
  if (value !== undefined && !UUID.test(value)) throw new WorkspaceIdentityError('LUMEN_WORKSPACE_ID must be a canonical lowercase workspace UUID. No station settings were changed.');
  return value;
}

function validate(value: unknown): Identity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkspaceIdentityError();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== 'createdAt,id,mode,version' || item.version !== 1
    || !['local', 'provisioned'].includes(String(item.mode))
    || typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.createdAt !== 'string'
    || !Number.isFinite(Date.parse(item.createdAt)) || new Date(item.createdAt).toISOString() !== item.createdAt) throw new WorkspaceIdentityError();
  return { version: 1, id: item.id, createdAt: item.createdAt, mode: item.mode as Identity['mode'] };
}

async function read(filename: string): Promise<Identity | null> {
  let handle;
  try {
    const before = await fs.lstat(filename);
    if (!ownedPrivateFile(before) || before.size > LIMIT) throw new WorkspaceIdentityError();
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!ownedPrivateFile(stat) || !sameFile(before, stat) || stat.size > LIMIT) throw new WorkspaceIdentityError();
    const buffer = Buffer.alloc(LIMIT + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > LIMIT) throw new WorkspaceIdentityError();
    const current = await fs.lstat(filename);
    if (!sameFile(current, stat) || !ownedPrivateFile(current)) throw new WorkspaceIdentityError();
    return validate(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
  } catch (error) {
    if (code(error) === 'ENOENT' && !handle) return null;
    if (error instanceof WorkspaceIdentityError) throw error;
    throw new WorkspaceIdentityError();
  } finally { await handle?.close(); }
}

/** Publish a complete private identity without ever replacing an existing one.
 * The station lease serializes normal startup; no-clobber publication also
 * keeps concurrent callers or a newly appeared file from changing the owner. */
async function publish(filename: string, identity: Identity): Promise<Identity> {
  const temporary = `${filename}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(identity, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close(); handle = undefined;
    try { await fs.link(temporary, filename); }
    catch (error) { if (code(error) !== 'EEXIST') throw error; }
    // Remove our second link before validating nlink === 1.
    await fs.unlink(temporary);
    const stored = await read(filename);
    if (!stored) throw new WorkspaceIdentityError();
    return stored;
  } catch (error) {
    if (error instanceof WorkspaceIdentityError) throw error;
    throw new WorkspaceIdentityError('The station workspace identity could not be saved safely. Existing station data was preserved; check directory permissions.');
  } finally { await handle?.close(); await fs.unlink(temporary).catch(() => {}); }
}

/** Resolve before opening production/auth/content stores. Each DATA_DIR has one
 * immutable namespace. Server provisioning may reuse a cloud team UUID, but an
 * ID alone never grants cloud membership, publishing rights or live control. */
export async function resolveStationWorkspace(directory: string, env: NodeJS.ProcessEnv = process.env): Promise<StationWorkspace> {
  const configured = configuredWorkspaceId(env);
  await fs.mkdir(directory, { recursive: true });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorkspaceIdentityError('The station data directory must be a real directory. Existing station files were preserved.');
  const filename = path.join(directory, 'workspace.json');
  const identity = await read(filename) ?? await publish(filename, { version: 1, id: configured ?? randomUUID(), createdAt: new Date().toISOString(), mode: configured ? 'provisioned' : 'local' });
  if (configured && identity.id !== configured) throw new WorkspaceIdentityError('This station data directory belongs to a different workspace. Use that workspace’s existing configuration or a separate empty data directory; never reuse another workspace’s scenes, keys or audio settings.');
  if (identity.mode === 'provisioned' && !configured) throw new WorkspaceIdentityError('This station is provisioned for a workspace and requires its matching LUMEN_WORKSPACE_ID. Removing server configuration cannot downgrade it to a local station. Existing station settings were preserved.');
  if (identity.mode === 'local' && configured) throw new WorkspaceIdentityError('This is an existing local station, not a provisioned workspace directory. Use a separate empty data directory with the verified workspace configuration; existing station settings were preserved.');
  return { id: identity.id, createdAt: identity.createdAt, mode: identity.mode, configured: !!configured,
    message: configured
      ? 'Server-provisioned workspace namespace. Cloud membership and relay publishing credentials are checked separately; this ID does not grant access.'
      : 'Local workspace namespace for this station. Selecting a cloud team never reassigns this station; provisioning a cloud workspace requires a separate, matching station configuration.' };
}
