import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DATA_DIR } from './paths.js';

const aliasesSchema = z.record(z.string().trim().min(1).max(160));
export const mediaAliasFile = (dir = DATA_DIR) => path.join(dir, 'media-library.json');
export async function readMediaAliases(dir = DATA_DIR): Promise<Record<string, string>> {
  try { return aliasesSchema.parse(JSON.parse(await fs.readFile(mediaAliasFile(dir), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}
