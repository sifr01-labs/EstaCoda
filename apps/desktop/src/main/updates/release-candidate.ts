import { createHash, createPublicKey, sign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { basename } from 'node:path';
import { verifiedRelease, type DesktopRelease, type ReleaseAsset } from './release-feed.js';

/** Build a candidate record from the final signed bytes. This never publishes,
 * notarizes, or treats metadata signing as native publisher verification. */
export async function releaseCandidate(input: {
  record: Omit<DesktopRelease, 'installer' | 'updater'>;
  installer: string; updater: string; privateKey: string; sourceRevision: string; tag: string; now: number;
}): Promise<string> {
  const { record } = input;
  if (record.sourceRevision !== input.sourceRevision || input.tag !== 'desktop-v' + record.version) throw Error('Release source/tag mismatch');
  const key = createPublicKey(input.privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw Error('Expected Ed25519 release key');
  const asset = async (path: string, extension: string): Promise<ReleaseAsset> => {
    const name = `EstaCoda-${record.version}-darwin-${record.arch}.${extension}`;
    if (basename(path) !== name) throw Error('Unexpected release filename');
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 2 * 1024 ** 3) throw Error('Invalid release file');
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of createReadStream(path)) { bytes += chunk.length; if (bytes > stat.size) throw Error('Release file changed'); hash.update(chunk); }
    if (bytes !== stat.size) throw Error('Release file changed');
    return { url: `https://github.com/sifr01-labs/EstaCoda/releases/download/${input.tag}/${name}`, bytes, sha256: hash.digest('hex') };
  };
  const payload = Buffer.from(JSON.stringify({ ...record, installer: await asset(input.installer, 'dmg'), updater: await asset(input.updater, 'zip') }));
  const envelope = JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, input.privateKey).toString('base64') });
  verifiedRelease(Buffer.from(envelope), { publicKey: key.export({ type: 'spki', format: 'pem' }).toString(), teamId: record.teamId, now: input.now });
  if (Buffer.byteLength(envelope) > 16384) throw Error('Release record exceeds client limit');
  return envelope;
}
