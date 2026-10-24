import type { AgentSnapshot, Content, Role, RoleGrant, User } from '@/types';

const BASE = '/api';

export interface AdminUser extends User {
  grants: RoleGrant[];
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return (await res.json()) as T;
}

export interface AuthMe {
  user: User;
  grants: RoleGrant[];
}

export interface MediaLibraryFile {
  name: string;
  path: string;
  thumbnail?: string | null;
  bytes?: number;
  modifiedAt?: string;
}

interface MediaUploadOptions {
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}

export const api = {
  async getContent(): Promise<Content> {
    return json<Content>(await fetch(`${BASE}/content`, { credentials: 'include' }));
  },
  async putContent(content: Content): Promise<Content> {
    return json<Content>(
      await fetch(`${BASE}/content`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Lumen-Content-Version': content.updatedAt },
        body: JSON.stringify(content),
      }),
    );
  },
  // Returns null on 401 (not authenticated). Throws only on network/other errors,
  // so the identity store can keep a cached session for offline-tolerant UI.
  async me(): Promise<AuthMe | null> {
    const res = await fetch(`${BASE}/auth/me`, { credentials: 'include' });
    if (res.status === 401) return null;
    return json<AuthMe>(res);
  },
  async login(username: string, password: string): Promise<AuthMe> {
    return json<AuthMe>(
      await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }),
    );
  },
  async logout(): Promise<void> {
    await fetch(`${BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
  },
  // ── Admin: user + role management ──
  async listUsers(): Promise<{ users: AdminUser[] }> {
    return json(await fetch(`${BASE}/users`, { credentials: 'include' }));
  },
  async createUser(body: {
    username: string;
    password: string;
    displayName?: string;
    isAdmin?: boolean;
  }): Promise<{ user: User }> {
    return json(
      await fetch(`${BASE}/users`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  },
  async setGrant(userId: string, channelId: string, role: Role): Promise<void> {
    await json(
      await fetch(`${BASE}/users/${encodeURIComponent(userId)}/grants`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, role }),
      }),
    );
  },
  // ── Admin: capture agents ──
  async listAgents(): Promise<{ agents: AgentSnapshot[] }> {
    return json(await fetch(`${BASE}/agents`, { credentials: 'include' }));
  },
  async createAgent(name: string): Promise<{ agentId: string; token: string; name: string }> {
    return json(
      await fetch(`${BASE}/agents`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    );
  },
  async deleteAgent(id: string): Promise<void> {
    await json(await fetch(`${BASE}/agents/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' }));
  },
  async setUserPassword(userId: string, password: string): Promise<void> {
    await json(
      await fetch(`${BASE}/users/${encodeURIComponent(userId)}/password`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      }),
    );
  },
  async listMedia(kind: 'backgrounds' | 'music', signal?: AbortSignal): Promise<MediaLibraryFile[]> {
    return json(await fetch(`${BASE}/media/${kind}`, { signal }));
  },
  async uploadMedia(
    kind: 'backgrounds' | 'music',
    file: File,
    options?: MediaUploadOptions,
  ): Promise<{ path: string; thumbnail: string | null }> {
    const fd = new FormData();
    fd.append('file', file);
    if (!options?.onProgress) return json(await fetch(`${BASE}/media/${kind}`, { method: 'POST', body: fd, signal: options?.signal }));
    // Upload progress is separate from thumbnail processing on the station.
    // Existing callers retain fetch; the media browser opts into progress and
    // can cancel when the dialog closes or its source type changes.
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const cleanup = () => options.signal?.removeEventListener('abort', abort);
      if (options.signal?.aborted) { reject(new DOMException('Upload cancelled.', 'AbortError')); return; }
      xhr.open('POST', `${BASE}/media/${kind}`);
      xhr.withCredentials = true;
      xhr.upload.onprogress = event => { if (event.lengthComputable) options.onProgress?.(Math.round(event.loaded / event.total * 100)); };
      xhr.onload = () => {
        cleanup();
        if (!xhr.status) { reject(new Error('Could not upload this file. Check your connection and try again.')); return; }
        void json<{ path: string; thumbnail: string | null }>(new Response(xhr.responseText, { status: xhr.status, statusText: xhr.statusText })).then(resolve, reject);
      };
      xhr.onerror = () => { cleanup(); reject(new Error('Could not upload this file. Check your connection and try again.')); };
      xhr.onabort = () => { cleanup(); reject(new DOMException('Upload cancelled.', 'AbortError')); };
      options.signal?.addEventListener('abort', abort, { once: true });
      try { xhr.send(fd); } catch (error) { cleanup(); reject(error); }
    });
  },
  async deleteMedia(kind: 'backgrounds' | 'music', filename: string): Promise<void> {
    await json(
      await fetch(`${BASE}/media/${kind}/${encodeURIComponent(filename)}`, { method: 'DELETE' }),
    );
  },
};

export interface StagingItem {
  id: string;
  origName: string;
  mime: string | null;
  size: number | null;
  targetKind: 'backgrounds' | 'music';
  contributor: string | null;
  thumbnail: string | null;
  createdAt: string;
  rawUrl: string;
}

export const mediaApi = {
  // Public — no auth (phones contribute without logging in).
  async contribute(file: File, targetKind: 'backgrounds' | 'music', contributor: string): Promise<{ id: string; status: string }> {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('targetKind', targetKind);
    if (contributor) fd.append('contributor', contributor);
    return json(await fetch(`${BASE}/contribute`, { method: 'POST', body: fd }));
  },
  async listStaging(): Promise<{ pending: StagingItem[] }> {
    return json(await fetch(`${BASE}/staging`, { credentials: 'include' }));
  },
  async approveStaging(id: string): Promise<{ path: string; thumbnail: string | null }> {
    return json(await fetch(`${BASE}/staging/${encodeURIComponent(id)}/approve`, { method: 'POST', credentials: 'include' }));
  },
  async rejectStaging(id: string): Promise<void> {
    await json(await fetch(`${BASE}/staging/${encodeURIComponent(id)}/reject`, { method: 'POST', credentials: 'include' }));
  },
  // ── Stream egress control ──
  async streamStatus(): Promise<{ enabled: boolean; egress: unknown[]; ingest: unknown[] }> {
    return json(await fetch(`${BASE}/media/stream/status`, { credentials: 'include' }));
  },
  async streamTargets(): Promise<{ targets: Array<{ destinationId: string; platform: string; rtmpUrl: string; hasKey: boolean }> }> {
    return json(await fetch(`${BASE}/media/stream/targets`, { credentials: 'include' }));
  },
  async setStreamTarget(destinationId: string, body: { platform: string; rtmpUrl: string; streamKey: string }): Promise<void> {
    await json(
      await fetch(`${BASE}/media/stream/${encodeURIComponent(destinationId)}/target`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  },
  async startStream(destinationId: string): Promise<{ ok: boolean }> {
    return json(await fetch(`${BASE}/media/stream/${encodeURIComponent(destinationId)}/start`, { method: 'POST', credentials: 'include' }));
  },
  async stopStream(destinationId: string): Promise<{ ok: boolean }> {
    return json(await fetch(`${BASE}/media/stream/${encodeURIComponent(destinationId)}/stop`, { method: 'POST', credentials: 'include' }));
  },
};

export function mediaUrl(rel?: string): string | undefined {
  if (!rel) return undefined;
  if (rel.startsWith('http')) return rel;
  // content.json stores paths like "media/backgrounds/foo.jpg"; backend serves them at /media/...
  return rel.startsWith('media/') ? `/${rel}` : `/media/${rel}`;
}
