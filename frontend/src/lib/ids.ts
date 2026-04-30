// Short, prefix-tagged IDs for human readability in content.json.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function shortId(prefix: string, len = 6): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `${prefix}_${out}`;
}
