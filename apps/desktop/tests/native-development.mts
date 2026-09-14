/** Exercise Forge's real dual-renderer development startup, including a restart. */
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const desktop=fileURLToPath(new URL('../',import.meta.url));
const evidence=mkdtempSync(join(tmpdir(),'ec-dev-start-'));
for(const attempt of ['first-launch','restart']) {
 const report=join(evidence,attempt+'.json');
 const entry=join(evidence,attempt+'.cjs');
 // Only profile/presentation paths are isolated. Main, preload, IPC, Vite, and
 // runtime staging are the actual development launch, without fixture adapters.
 writeFileSync(entry,`
 const {app}=require('electron');
 const fs=require('node:fs');
 app.setPath('home',${JSON.stringify(evidence)});
 app.setPath('userData',${JSON.stringify(join(evidence,'desktop-data'))});
 app.setAppPath(${JSON.stringify(desktop)});
 const failures=[];let finished=false;
 const finish=(ok,reason)=>{if(finished)return;finished=true;fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({ok,reason,failures}));app.exit(ok?0:1);};
 const deadline=setTimeout(()=>finish(false,'Startup timed out'),30000);
 app.on('web-contents-created',(_,wc)=>{
   wc.on('preload-error',()=>failures.push('preload-error'));
   wc.on('render-process-gone',()=>finish(false,'Renderer exited'));
   wc.session.webRequest.onCompleted(details=>{
     if(details.statusCode>=400)failures.push(details.statusCode+':'+new URL(details.url).pathname);
   });
   wc.on('did-finish-load',()=>{
     void (async()=>{
       for(let i=0;i<100&&!finished;i++){
         const ready=await wc.executeJavaScript(${JSON.stringify("Boolean(document.querySelector('#ec-branded-workspace') && document.body.innerText.includes('Welcome to EstaCoda') && window.desktop)")});
         if(ready){await new Promise(r=>setTimeout(r,500));clearTimeout(deadline);finish(failures.length===0,'Live onboarding rendered');return;}
         await new Promise(r=>setTimeout(r,100));
       }
       finish(false,'Document loaded without the application');
     })().catch(()=>finish(false,'Renderer inspection failed'));
   });
 });
 require(${JSON.stringify(join(desktop,'.vite/build/main.cjs'))});
 `);
 const command=process.platform==='win32'?'pnpm.cmd':'pnpm';
 const child=spawn(command,['exec','electron-forge','start','--app-path',entry],{cwd:desktop,stdio:'inherit',detached:process.platform!=='win32'});
 const code=await new Promise<number|null>((resolve,reject)=>{
   const timeout=setTimeout(()=>{
     // Terminate only the process group created by this test.
     if(child.pid&&process.platform!=='win32')process.kill(-child.pid,'SIGTERM');else child.kill();
     reject(new Error('Forge startup timed out'));
   },180000);
   child.once('error',error=>{clearTimeout(timeout);reject(error);});
   child.once('exit',code=>{clearTimeout(timeout);resolve(code);});
 });
 assert.equal(code,0,attempt+' failed; evidence: '+report);
 const result=JSON.parse(readFileSync(report,'utf8'));
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.deepEqual(result.failures,[]);
 console.log(attempt+': live onboarding rendered without failed asset requests');
}
console.log('Development startup evidence: '+resolve(evidence));
