import { defineConfig } from 'vite';
import { randomUUID } from 'node:crypto';
import react from '@vitejs/plugin-react';
export default defineConfig(({command}) => {
  const nonce=randomUUID();
  return { base:'./', resolve:{preserveSymlinks:false}, plugins:[react(), ...(command==='serve'?[{
    name:'local-development-csp',transformIndexHtml(html:string){return html.replace("script-src 'self'",`script-src 'self' 'nonce-${nonce}'`);},
  }]:[])], html:command==='serve'?{cspNonce:nonce}:undefined, build:{sourcemap:false} };
});
