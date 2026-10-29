import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const outputDirectory = metadata.build?.directories?.output;
const productName = metadata.build?.productName;

if (!outputDirectory || !productName || !metadata.version) {
  throw new Error('package.json is missing version or Windows build metadata.');
}

const executable = resolve(root, outputDirectory, 'win-unpacked', `${productName}.exe`);
if (!existsSync(executable)) {
  throw new Error(`Packaged executable not found: ${executable}`);
}

const evidenceDirectory = resolve(root, 'artifacts', `packaged-smoke-${metadata.version}`);
const result = spawnSync(executable, [
  '--agent-smoke',
  `--evidence-dir=${evidenceDirectory}`,
], {
  cwd: root,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
