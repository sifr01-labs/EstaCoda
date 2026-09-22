import { expect, it } from 'vitest';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { releaseCandidate } from './release-candidate.js';
import { verifiedRelease } from './release-feed.js';
import { fixture, now } from './release-fixtures.js';
it('binds candidate metadata to final artifact bytes and matching source tag without publishing', async () => {
  const root = mkdtempSync('/tmp/ec-release-candidate-');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const record = fixture(), installer = root + '/EstaCoda-1.2.0-darwin-arm64.dmg', updater = root + '/EstaCoda-1.2.0-darwin-arm64.zip';
  const input = { record, installer, updater, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), sourceRevision: record.sourceRevision, tag: 'desktop-v1.2.0', now };
  try {
    writeFileSync(installer, 'synthetic installer'); writeFileSync(updater, 'synthetic updater');
    const result = verifiedRelease(Buffer.from(await releaseCandidate(input)), { publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), teamId: record.teamId, now });
    expect(result.updater.sha256).toBe(createHash('sha256').update('synthetic updater').digest('hex'));
    expect(result.installer.bytes).toBe(19);
    await expect(releaseCandidate({ ...input, tag: 'desktop-v1.1.0' })).rejects.toThrow('source/tag');
    await expect(releaseCandidate({ ...input, sourceRevision: 'f'.repeat(40) })).rejects.toThrow('source/tag');
    rmSync(updater); symlinkSync(installer, updater);
    await expect(releaseCandidate(input)).rejects.toThrow('Invalid release file');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
