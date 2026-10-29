import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputArg = process.argv.find((value) => value.startsWith('--output='));
const output = resolve(root, outputArg ? outputArg.slice('--output='.length) : '04_Tasks/T001_agent_workspace/files/unit-tests.tap');
const tests = readdirSync(resolve(root, 'tests')).filter((name) => name.endsWith('.test.mjs')).map((name) => `tests/${name}`);
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], { cwd: root, encoding: 'utf8' });
const log = `${result.stdout || ''}\n${result.stderr || ''}`;
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, log);
process.stdout.write(log);
process.exitCode = result.status ?? 1;
