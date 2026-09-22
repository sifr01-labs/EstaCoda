import { expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { allowedReleaseUrl, readBounded, releaseResponse } from './network.js';
import { stageDownload } from './download.js';
import { UpdateDownloads } from './download-controller.js';
import { UpdateCoordinator } from './coordinator.js';
import { UpdateDiscovery } from './discovery.js';
import { fixture, envelope, publicKey, now } from './release-fixtures.js';

it('rejects hostile redirects before contacting their destination and bounds redirect loops', async () => {
  for (const url of ['http://github.com/a', 'https://github.com.evil.test/a', 'https://user@github.com/a', 'https://github.com:123/a', 'file:///tmp/a', 'https://127.0.0.1/a']) {
    expect(() => allowedReleaseUrl(url)).toThrow();
    let calls = 0;
    await expect(releaseResponse('https://github.com/a', new AbortController().signal, (async () => {
      calls++; return new Response(null, { status: 302, headers: { location: url } });
    }) as typeof fetch)).rejects.toThrow();
    expect(calls).toBe(1);
  }
  let calls = 0;
  await expect(releaseResponse('https://github.com/a', new AbortController().signal, (async (_url, options) => {
    calls++; expect(options?.credentials).toBe('omit'); expect(options?.redirect).toBe('manual');
    return new Response(null, { status: 302, headers: { location: '/a' } });
  }) as typeof fetch)).rejects.toThrow('Too many');
  expect(calls).toBe(5);
});

it('bounds both declared and streamed metadata and rejects truncated, oversized or changed archives', async () => {
  await expect(readBounded(new Response('a', { headers: { 'content-length': '9999' } }), 10)).rejects.toThrow();
  await expect(readBounded(new Response('a'.repeat(11)), 10)).rejects.toThrow();
  const directory = mkdtempSync('/tmp/ec-hostile-download-');
  const release = fixture(); release.updater.bytes = 3; release.updater.sha256 = createHash('sha256').update('abc').digest('hex');
  const base = { directory, release, signal: new AbortController().signal, progress: () => {}, verify: async () => {} };
  try {
    for (const body of ['ab', 'abcd']) await expect(stageDownload({ ...base, fetcher: (async () => new Response(body)) as typeof fetch })).rejects.toThrow();
    await expect(stageDownload({ ...base, fetcher: (async () => new Response('abc')) as typeof fetch, verify: async path => { writeFileSync(path, 'bad'); } })).rejects.toThrow('verification_failed');
    expect(readdirSync(directory)).toEqual([]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const options = { version: '1.0.0', platform: 'darwin', arch: 'arm64', os: '15.0.0', protocol: 1, schema: 36, publicKey, teamId: 'ABCDEFGHIJ', now: () => now, installation: () => ({ ownership: 'owned' as const, canReplace: true }) };

it('never offers older or incompatible releases', async () => {
  for (const [release, expected] of [[fixture('0.9.0'), 'current'], [{ ...fixture(), minimumOs: '99.0.0' }, 'failed'], [{ ...fixture(), schema: { min: 99, max: 99 } }, 'failed']] as const) {
    const discovery = new UpdateDiscovery({ ...options, fetcher: (async () => new Response(Buffer.from(envelope(release)).toString())) as typeof fetch });
    expect((await discovery.check()).phase).toBe(expected);
    expect(discovery.status().availableVersion).toBeUndefined();
  }
});

it('serializes separate download owners and cancels without promoting a partial archive', async () => {
  const directory = mkdtempSync('/tmp/ec-cancel-download-'), release = fixture();
  release.updater.bytes = 3; release.updater.sha256 = createHash('sha256').update('abc').digest('hex');
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { finish = resolve; });
  const fetcher = (async (url: unknown) => new Response(String(url).endsWith('latest.json') ? Buffer.from(envelope(release)).toString() : 'abc')) as typeof fetch;
  const first = new UpdateDownloads({ ...options, fetcher }, new UpdateCoordinator(directory), async () => { entered(); await hold; });
  const second = new UpdateDownloads({ ...options, fetcher }, new UpdateCoordinator(directory), async () => {});
  try {
    await first.check(); await second.check(); const download = first.download(); expect(first.download()).toBe(download);
    await started; expect((await second.download()).problem).toBe('busy');
    const cancelled = first.cancel(); finish(); expect((await cancelled).phase).toBe('available'); await download;
    expect(readdirSync(directory)).toEqual([]);
  } finally { finish?.(); rmSync(directory, { recursive: true, force: true }); }
});
