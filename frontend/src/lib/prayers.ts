import type { Item } from '@/types';

export interface PrayerLabel {
  /** "1", "2", … for top-level prayers; "1", "2", … of the parent for subs */
  number: number;
  /** "a", "b", … for sub-prayers; '' for top-level */
  letter: string;
  /** Display string: "1.", "1a.", etc. */
  display: string;
}

/**
 * Walk the playlist in order and assign prayer numbers automatically.
 *
 * Rules:
 * - A `section` item resets the prayer counter.
 * - A `prayer` item gets the next integer ("1.", "2.", …).
 * - A `prayer-sub` item inherits the most recent prayer's number and gets the
 *   next letter ("1a.", "1b.", …). If a sub appears before any prayer in its
 *   section, it falls back to numbering as if it were a top-level prayer.
 * - Non-prayer items (scripture, text, etc.) don't reset the sub counter so a
 *   passage can appear between subs without renumbering them.
 */
export function computePrayerLabels(items: Item[]): Record<string, PrayerLabel> {
  const out: Record<string, PrayerLabel> = {};
  let prayerCount = 0;
  let subCount = 0;

  for (const item of items) {
    if (item.type === 'section') {
      prayerCount = 0;
      subCount = 0;
      continue;
    }
    if (item.type === 'prayer') {
      prayerCount += 1;
      subCount = 0;
      out[item.id] = {
        number: prayerCount,
        letter: '',
        display: `${prayerCount}.`,
      };
      continue;
    }
    if (item.type === 'prayer-sub') {
      // No parent prayer yet → treat as a top-level placeholder so the operator
      // sees something useful instead of a blank pill.
      const number = prayerCount === 0 ? ++prayerCount : prayerCount;
      subCount += 1;
      const letter = String.fromCharCode(96 + subCount); // 97 = 'a'
      out[item.id] = {
        number,
        letter,
        display: `${number}${letter}.`,
      };
    }
  }

  return out;
}
