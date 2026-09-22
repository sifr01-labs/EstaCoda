import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { releaseCandidate } from '../src/main/updates/release-candidate.js';
import { versionParts } from '../src/main/updates/release-feed.js';

// Run from the repository root. Arguments are local paths, never key material.
// Candidate generation is offline and cannot publish or certify native signing.
try {
  const [recordPath, installer, updater, keyPath, output] = process.argv.slice(2);
  if (!recordPath || !installer || !updater || !keyPath || !output || process.argv.length !== 7) throw Error();
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  versionParts(record.version);
  const desktop = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8'));
  const core = JSON.parse(readFileSync('package.json', 'utf8'));
  if (record.version !== desktop.version || record.coreVersion !== core.version) throw Error();
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const sourceRevision = git('rev-parse', 'HEAD'), tag = 'desktop-v' + record.version;
  if (git('rev-parse', '--verify', tag + '^{commit}') !== sourceRevision) throw Error();
  git('diff', '--quiet', 'HEAD');
  const candidate = await releaseCandidate({ record, installer, updater, privateKey: readFileSync(keyPath, 'utf8'), sourceRevision, tag, now: Date.now() });
  writeFileSync(output, candidate + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Signed metadata candidate written. Native signing and release acceptance are still required; nothing was published.');
} catch {
  console.error('Release candidate rejected. Check source/tag versions, record, final assets, key and unused output path.');
  process.exitCode = 1;
}
