// Local Apple Silicon builds need a final ad-hoc signature after Forge updates
// Info.plist. Developer ID signing remains owned by release CI.
import{execFileSync}from'node:child_process';
import{cpSync,mkdtempSync,rmSync}from'node:fs';
import{resolve,join,relative}from'node:path';
const output=resolve(import.meta.dirname,'../out');
for(const directory of process.argv.slice(2)){
 const bundle=join(resolve(directory),'EstaCoda.app');const child=relative(output,bundle);
 if(child.startsWith('..')||child.startsWith('/'))throw Error('Expected a generated desktop output.');
 // File-provider folders can synthesize FinderInfo on .app directories. Sign a
 // data-only copy outside those folders; keep framework links relative.
 const temporary=mkdtempSync('/tmp/ec-desktop-sign-');
 try{
  const staged=join(temporary,'EstaCoda.app');cpSync(bundle,staged,{recursive:true,verbatimSymlinks:true});
  execFileSync('codesign',['--force','--deep','--sign','-','--preserve-metadata=entitlements,flags,runtime',staged],{stdio:'inherit'});
  execFileSync('codesign',['--verify','--deep','--strict',staged],{stdio:'inherit'});
  // Preserve the verified bundle in an archive before File Provider metadata can
  // be synthesized on the destination .app. Relocation tests verify its bytes.
  execFileSync('ditto',['-c','-k','--keepParent',staged,join(resolve(directory),'EstaCoda.app.zip')],{stdio:'inherit'});
  rmSync(bundle,{recursive:true,force:true});cpSync(staged,bundle,{recursive:true,verbatimSymlinks:true});
 }finally{rmSync(temporary,{recursive:true,force:true});}
}
