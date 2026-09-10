import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length > 3) throw new Error('Usage: validate-execution-release.mjs [engine-shared-test-parent]');
const parent = resolve(process.argv[2] ?? root);
const steps = [
  ['--version'], ['install', '--frozen-lockfile'],
  ['run', 'validate:execution-conformance', '--check-only'],
  ...['typecheck', 'test', 'smoke', 'build', 'audit:runtime-imports', 'audit:esm', 'smoke:dist'].map((name) => ['run', name]),
  ['run', 'validate:execution-budgets'],
  ['run', 'validate:execution-docker', parent],
  ['run', 'validate:execution-docker', '--dist', parent],
  ['run', 'validate:docker']
];
console.log(`Required host/Docker release validation; Node ${process.version}`);
const hygiene = spawnSync('git', ['diff', '--check'], { cwd: root, stdio: 'inherit', timeout: 30_000 });
if (hygiene.error) throw hygiene.error;
if (hygiene.status !== 0) throw new Error('Release patch hygiene failed.');
for (const args of steps) {
  const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit', timeout: 1_200_000,
    env: { ...process.env, CI: 'true', NODE_ENV: 'test', ESTACODA_REQUIRE_DOCKER: '1' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Release gate failed: pnpm ${args.join(' ')} (${result.status ?? result.signal}).`);
}
console.log('Required host/Docker release validation passed.');
