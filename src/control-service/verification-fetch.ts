import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';
import {isSafeUrl, resolveHostname, normalizeHostname, isPrivateOrInternalIp} from '../browser/url-safety.js';
import type {FetchLike} from '../providers/openai-compatible-provider.js';

/** One bounded request, pinned to the validated DNS result. Redirects are never followed. */
export function verificationFetch(endpoint: string, allowPrivateUrls: boolean, signal: AbortSignal): FetchLike {
  let dispatched = false;
  return async (url, init) => {
    const target = new URL(url), base = new URL(endpoint);
    if (dispatched || target.origin !== base.origin || !target.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/') || target.search || target.hash) throw new Error('Invalid verification destination');
    dispatched = true;
    const hostname = normalizeHostname(target.hostname);
    const addresses = await Promise.race([resolveHostname(hostname, undefined), new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Error('Cancelled'));
      else signal.addEventListener('abort', () => reject(new Error('Cancelled')), {once:true});
    })]);
    signal.throwIfAborted();
    if (!await isSafeUrl(url, {allowPrivateUrls, resolveHostname: () => addresses})) throw new Error('Invalid verification destination');
    if (target.protocol === 'http:' && !addresses.every(isPrivateOrInternalIp)) throw new Error('TLS required for public endpoints');
    const address = addresses[0];
    if (!address || !isIP(address)) throw new Error('Invalid verification destination');
    return await new Promise((resolve, reject) => {
      const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
        method: init.method, headers: init.headers, signal, family:isIP(address),
        lookup: (_hostname, _options, done) => done(null, address, isIP(address)),
      }, response => {
        let bytes = 0; const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 65_536) {reject(new Error('Verification response exceeded limit'));response.destroy(); request.destroy();}
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const data = Buffer.concat(chunks), status = response.statusCode ?? 0;
          resolve({ok:status>=200 && status<300,status,statusText:'',
            json: async () => JSON.parse(data.toString('utf8')),text: async () => data.toString('utf8'),
            body: new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(data));controller.close();}})});
        });
      });
      request.on('error', reject); request.end(init.body);
    });
  };
}
