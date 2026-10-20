import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, access, lstat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const evaluationDirectory = dirname(fileURLToPath(import.meta.url));

export async function createEvaluationSecrets(directory = evaluationDirectory) {
  const environmentPath = join(directory, '.env.local');
  const runtimePath = join(directory, '.runtime');
  const privateKeyPath = join(runtimePath, 'signing-key.pem');
  try {
    const runtime = await lstat(runtimePath);
    if (!runtime.isDirectory() || runtime.isSymbolicLink()) {
      throw new Error('Evaluation credential path must be a real local directory, not a symlink.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const path of [environmentPath, privateKeyPath]) {
    try {
      await access(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error('Evaluation credentials already exist. Refusing to overwrite them.');
  }
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const secret = () => randomBytes(32).toString('base64url');
  await mkdir(runtimePath, { recursive: true, mode: 0o700 });
  await writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
  await writeFile(environmentPath, [
    '# Generated local evaluation secrets. Never commit or reuse in production.',
    `PS_DB_ADMIN_PASSWORD=${secret()}`,
    `PS_REPLICATION_PASSWORD=${secret()}`,
    `PS_STORAGE_PASSWORD=${secret()}`,
    `PS_JWK_N=${jwk.n}`,
    '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  return { environmentPath, privateKeyPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await createEvaluationSecrets();
    console.log('Created private local evaluation credentials; no secrets printed.');
    console.log('Next: docker compose --env-file infra/powersync/.env.local -f infra/powersync/compose.yaml config --quiet');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
