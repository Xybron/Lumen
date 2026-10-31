import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from '../../frontend/src/lib/api';

test('API errors show a short explanation instead of a server HTML page', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('<html><pre>MulterError: File too large\n/secret/path</pre></html>', { status: 413 });
    await assert.rejects(api.getContent(), { message: 'This file is too large to upload.' });
    globalThis.fetch = async () => new Response('<html><pre>Internal stack trace</pre></html>', { status: 500 });
    await assert.rejects(api.getContent(), { message: 'Lumen had trouble completing this request. Please try again.' });
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Free some space on this station.' }), { status: 507 });
    await assert.rejects(api.getContent(), { message: 'Free some space on this station.' });
  } finally {
    globalThis.fetch = previous;
  }
});
