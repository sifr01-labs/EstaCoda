import {it,expect} from 'vitest';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {BUILTIN_TOOLSETS} from '../contracts/tool.js';
// A new built-in registration must update the side-effect-free review vocabulary.
// MCP registrations use "mcp"; reviewing names never loads a server or provider.
it('covers every literal built-in toolset registration in runtime source',()=>{
 const root=fileURLToPath(new URL('../',import.meta.url)),seen=new Set<string>();
 function walk(path:string){for(const item of readdirSync(path,{withFileTypes:true})){const child=join(path,item.name);if(item.isDirectory()){if(!['test','smoke','benchmark','eval'].includes(item.name))walk(child);continue;}if(!item.name.endsWith('.ts')||item.name.includes('.test.')||item.name.includes(' 2.'))continue;
  const source=ts.createSourceFile(child,readFileSync(child,'utf8'),ts.ScriptTarget.Latest,true);
  function visit(node:ts.Node){if(ts.isPropertyAssignment(node)&&node.name.getText(source)==='toolsets'&&ts.isArrayLiteralExpression(node.initializer))for(const value of node.initializer.elements)if(ts.isStringLiteral(value))seen.add(value.text);ts.forEachChild(node,visit);}visit(source);
 }}walk(root);
 expect([...seen].sort()).toEqual([...BUILTIN_TOOLSETS].sort());
});
