import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Password hashing with scrypt (built into node:crypto — no external dep). Each
// password gets a random salt; verification is constant-time.
export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const test = scryptSync(password, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return test.length === known.length && timingSafeEqual(test, known);
}
