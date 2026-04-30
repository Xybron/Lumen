import type { Content } from '@/types';

const BASE = '/api';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return (await res.json()) as T;
}

export const api = {
  async getContent(): Promise<Content> {
    return json<Content>(await fetch(`${BASE}/content`));
  },
  async putContent(content: Content): Promise<Content> {
    return json<Content>(
      await fetch(`${BASE}/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(content),
      }),
    );
  },
  async listMedia(kind: 'backgrounds' | 'music'): Promise<{ name: string; path: string }[]> {
    return json(await fetch(`${BASE}/media/${kind}`));
  },
  async uploadMedia(
    kind: 'backgrounds' | 'music',
    file: File,
  ): Promise<{ path: string; thumbnail: string | null }> {
    const fd = new FormData();
    fd.append('file', file);
    return json(await fetch(`${BASE}/media/${kind}`, { method: 'POST', body: fd }));
  },
  async deleteMedia(kind: 'backgrounds' | 'music', filename: string): Promise<void> {
    await json(
      await fetch(`${BASE}/media/${kind}/${encodeURIComponent(filename)}`, { method: 'DELETE' }),
    );
  },
};

export function mediaUrl(rel?: string): string | undefined {
  if (!rel) return undefined;
  if (rel.startsWith('http')) return rel;
  // content.json stores paths like "media/backgrounds/foo.jpg"; backend serves them at /media/...
  return rel.startsWith('media/') ? `/${rel}` : `/media/${rel}`;
}
