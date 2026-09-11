import {createServer} from 'node:http';
import {expect,it} from 'vitest';
import {verificationFetch} from './verification-fetch.js';
it('requires explicit local-network approval, bounds responses and refuses redirect follow-up', async () => {
  let hits=0;
  const server=createServer((req,res)=>{hits++;if(req.url==='/v1/large'){res.end('x'.repeat(70_000));}else{res.writeHead(302,{location:'http://169.254.169.254/latest/meta-data'});res.end();}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address || typeof address==='string')throw new Error('No port');
  const endpoint=`http://127.0.0.1:${address.port}/v1`;
  const init={method:'POST',headers:{},body:'{}'};
  try {
    await expect(verificationFetch(endpoint,false,AbortSignal.timeout(2000))(endpoint+'/models',init)).rejects.toThrow();
    expect(hits).toBe(0);
    const fetch=verificationFetch(endpoint,true,AbortSignal.timeout(2000));
    expect((await fetch(endpoint+'/models',init)).status).toBe(302);
    expect(hits).toBe(1);
    await expect(fetch(endpoint+'/models',init)).rejects.toThrow();
    expect(await verificationFetch(endpoint,true,AbortSignal.timeout(2000))(endpoint+'/large',init).then(()=>false,()=>true)).toBe(true);
    expect(hits).toBe(2);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
