import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Core consumers of the shared ownership matrix. Packaged Desktop and Windows
// transport are separate delivery gates, not silently skipped tests here.
const groups = {
  ownership: [
    'src/session/execution-ownership.test.ts', 'src/gateway/shared-host-startup.test.ts',
    'src/gateway/shared-session-host.test.ts', 'src/gateway/control-receipts.test.ts',
    'src/gateway/private-control.test.ts', 'src/runtime/runtime-cache.test.ts',
    'src/runtime/workspace-execution-baseline.test.ts', 'src/workspaces/workspace-concurrency.test.ts'
  ],
  surfaces: [
    'src/runtime/host-execution-baseline.test.ts', 'src/cli/session-handoff-surfaces.test.ts',
    'src/acp/session-ownership.test.ts', 'src/acp/approval-ownership.test.ts',
    'src/acp/server.test.ts', 'src/channels/channel-workspace-store.test.ts',
    'src/cron/cron-authority.test.ts', 'src/tasks/foreground-task-handoff.acceptance.test.ts',
    'src/session/session-workspace-ownership.test.ts'
  ],
  environment: [
    'src/execution/host-parity.test.ts', 'src/execution/host-environment.test.ts',
    'src/execution/host-processes.test.ts', 'src/execution/host-execution-bounds.test.ts',
    'src/execution/docker-container.test.ts', 'src/execution/docker-processes.test.ts',
    'src/execution/docker-tool-boundary.test.ts', 'src/execution/docker-receipts.test.ts',
    'src/runtime/live-execution-authority.test.ts', 'src/execution/release-stress.test.ts',
    'src/runtime/runtime-acquisition.test.ts', 'src/tools/tool-executor.test.ts',
    'src/security/approval-scope.test.ts', 'src/security/workspace-approval-controller.test.ts'
  ],
  application: [
    'src/workspaces/copy-workflow.acceptance.test.ts', 'src/workspaces/change-authorization.test.ts',
    'src/workspaces/change-application.test.ts', 'src/workspaces/change-recovery.test.ts',
    'src/workspaces/copy-security.test.ts', 'src/ui/workspace-change-summary.test.ts',
    'src/doctor/checks/execution.test.ts', 'src/trajectory/execution-metrics.test.ts',
    'src/trajectory/execution-observations.test.ts'
  ]
};
if (process.argv.slice(2).some((arg) => arg !== '--check-only')) throw new Error('Unknown conformance option');
const root = fileURLToPath(new URL('../', import.meta.url));
const tests = [...new Set(Object.values(groups).flat())];
for (const test of tests) if (!existsSync(new URL(`../${test}`, import.meta.url))) throw new Error(`Missing release conformance test: ${test}`);
console.log(`Required core execution conformance: ${Object.keys(groups).join(', ')} (${tests.length} files)`);
if (process.argv.includes('--check-only')) process.exit(0);
const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.node.config.ts', ...tests], {
  cwd: root, stdio: 'inherit', timeout: 600_000, env: { ...process.env, CI: 'true', NODE_ENV: 'test' }
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Execution conformance failed (${result.status ?? result.signal}).`);
