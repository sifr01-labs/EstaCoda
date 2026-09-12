import {expect,it} from 'vitest';
import ts from 'typescript';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {arabic,english} from './catalog.js';
// Deliberately unchanged technical examples, brands, endonyms and units.
const literalContent=new Set(['local','ESTACODA','EstaCoda','English','Telegram','Email','K','Kimi','Kimi K3','OpenAI-compatible','Chat Completions','Responses','SHA-256:','payments-api ·','payments-api','pnpm test -- retry','src/billing/client.ts','src/billing/retry.test.ts','−  return send(request);','estacoda --profile','setup','/attach','0.2s','1.4s']);
it('requires translated JSX text, accessible attributes and local error messages across shipped components',()=>{
 const root=fileURLToPath(new URL('../../renderer/',import.meta.url));
 const names=['app.tsx',...readdirSync(join(root,'components')).filter(n=>n.endsWith('.tsx')).map(n=>'components/'+n)];
 const failures:string[]=[];
 for(const name of names){
  const source=ts.createSourceFile(name,readFileSync(join(root,name),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const fail=(node:ts.Node,text:string)=>failures.push(`${name}:${source.getLineAndCharacterOfPosition(node.pos).line+1}: ${text}`);
  function visit(node:ts.Node){
   if(ts.isJsxText(node)){const text=node.text.trim();if(/[A-Za-z]/.test(text)&&!literalContent.has(text))fail(node,text);}
   if(ts.isJsxAttribute(node)&&['aria-label','title','alt','placeholder','label'].includes(node.name.getText(source))&&node.initializer&&ts.isStringLiteral(node.initializer)){
    const text=node.initializer.text;if(/[A-Za-z]/.test(text)&&!['ESTACODA','https://','local'].includes(text))fail(node,text);
   }
   if(ts.isCallExpression(node)&&['setError','setOperationError','owned','t'].includes(node.expression.getText(source))){
    const arg=node.arguments[0];if(arg&&ts.isStringLiteral(arg)&&arg.text&&!Object.hasOwn(english,arg.text))fail(node,arg.text);
   }
   ts.forEachChild(node,visit);
  }visit(source);
 }
 expect(failures).toEqual([]);
});
it('does not count English fallback as Arabic coverage',()=>{
 const technical=new Set(['OAuth','{slot}: {role}.']);
 for(const [key,value] of Object.entries(arabic))expect(/[\u0600-\u06ff]/.test(value)||technical.has(key),key).toBe(true);
});
