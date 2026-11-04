import type { SongSection } from '../../../../shared/worship';

export type SongSplitMode = 'blank' | 'line';

// Only a whole heading line is metadata. A word like "chorus" in a lyric
// and brackets within a sung line stay in the text.
const heading = /^(?:\[([^\]]{1,80})\]|((?:verse|chorus|pre[- ]?chorus|bridge|refrain|intro|outro|interlude|tag)(?:\s+\d+)?):?)$/i;

export function newSongSectionId(): string {
  // getRandomValues is also available when a station is opened over LAN HTTP.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function splitSongLyrics(text: string, mode: SongSplitMode, previous: readonly SongSection[] = []): SongSection[] {
  const sections: SongSection[] = [];
  let lines: string[] = [], label = '', hasLyrics = false;
  function finish() {
    if (lines.length) sections.push({ id: '', label, text: lines.join('\n') });
    lines = [];
  }
  for (const raw of text.split(/\r\n?|\n/)) {
    const line = raw.trim();
    if (!line) {
      finish();
      if (hasLyrics) label = '';
      hasLyrics = false;
      continue;
    }
    const match = line.match(heading);
    if (match) {
      finish();
      label = (match[1] || match[2]).trim();
      hasLyrics = false;
      continue;
    }
    lines.push(line);
    hasLyrics = true;
    if (mode === 'line') finish();
  }
  finish();

  // A name edited in the preview belongs to its section, even if a verse
  // is inserted above it. Match duplicate refrains in their original order.
  const used = new Set<string>();
  function retainIds(key: (section: SongSection) => string) {
    const groups = new Map<string, string[]>();
    for (let i = previous.length - 1; i >= 0; i--) {
      const section = previous[i];
      if (used.has(section.id)) continue;
      const value = key(section), matches = groups.get(value);
      if (matches) matches.push(section.id);
      else groups.set(value, [section.id]);
    }
    for (const section of sections) {
      if (section.id) continue;
      const id = groups.get(key(section))?.pop();
      if (id) { section.id = id; used.add(id); }
    }
  }
  if (previous.length) {
    retainIds(section => JSON.stringify([section.label, section.text]));
    retainIds(section => section.text);
  }
  sections.forEach((section, i) => {
    if (section.id) return;
    const sameSlot = sections.length === previous.length && previous[i];
    section.id = sameSlot && !used.has(sameSlot.id) ? sameSlot.id : newSongSectionId();
  });
  return sections;
}
