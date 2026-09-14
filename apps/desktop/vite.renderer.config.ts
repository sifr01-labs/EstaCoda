import { defineConfig } from 'vite';
import { randomUUID } from 'node:crypto';
import react from '@vitejs/plugin-react';
export default defineConfig(({command}) => {
  const nonce=randomUUID();
  // Forge serves both renderers concurrently; their optimizer caches must not overlap.
  return { base:'./', cacheDir:'.vite/cache/main-window', resolve:{preserveSymlinks:false}, plugins:[react(), ...(command==='serve'?[{
    name:'local-development-csp',transformIndexHtml(html:string){return html.replace("script-src 'self'",`script-src 'self' 'nonce-${nonce}'`);},
  }]:[])], html:command==='serve'?{cspNonce:nonce}:undefined, build:{sourcemap:false} };
});
