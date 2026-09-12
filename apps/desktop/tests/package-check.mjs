import{createRequire}from'node:module';import{readFileSync,writeFileSync,mkdirSync,cpSync,mkdtempSync,rmSync}from'node:fs';import{resolve,join}from'node:path';import{createHash}from'node:crypto';import{execFileSync,spawn}from'node:child_process';import{getCurrentFuseWire,FuseV1Options}from'@electron/fuses';import{once}from'node:events';
const desktop=resolve('apps/desktop');let require=createRequire(join(desktop,'package.json'));require=createRequire(require.resolve('@electron-forge/core'));require=createRequire(require.resolve('@electron/packager'));const asar=require('@electron/asar');
const app=join(desktop,'out/EstaCoda-darwin-arm64/EstaCoda.app'),resources=join(app,'Contents/Resources');const archive=join(resources,'app.asar');const files=asar.listPackage(archive);
const assert=(value,message)=>{if(!value)throw Error(message);};
assert(!files.some(p=>/fixture|\/tests\/|\/src\/|reference|\.map$|\.test\./.test(p)),'Release includes development assets.');
assert(files.filter(p=>p.includes('/node_modules/')).every(p=>p==='/node_modules/node-pty'||p.startsWith('/node_modules/node-pty/')), 'Unexpected packaged native dependency.');
assert(files.some(p=>p.endsWith('/pty.node'))&&files.some(p=>p.endsWith('/spawn-helper')),'Missing native PTY assets.');
const index=asar.extractFile(archive,'.vite/renderer/main_window/index.html').toString();assert(index.includes("script-src 'self'")&&!index.includes('unsafe-eval')&&!index.includes('nonce-'),'Invalid release CSP.');
const main=asar.extractFile(archive,'.vite/build/main.cjs').toString();assert(!main.includes('desktopTest')&&!main.includes('connectionForTest'),'Test hook in release.');
const preload=asar.extractFile(archive,'.vite/build/preload.cjs').toString();assert(preload.includes('browserControlWorkspace')&&preload.includes('browserControlSignIn'),'Missing semantic browser workspace preload.');assert(main.includes('credentials.browserDeliver'),'Missing dedicated protected browser delivery pipe.');
const fuse=await getCurrentFuseWire(join(app,'Contents/MacOS/EstaCoda'));
for(const key of [FuseV1Options.RunAsNode,FuseV1Options.GrantFileProtocolExtraPrivileges,FuseV1Options.EnableNodeOptionsEnvironmentVariable,FuseV1Options.EnableNodeCliInspectArguments])assert(fuse[key]===48,'Unsafe Electron fuse.');
for(const key of [FuseV1Options.EnableEmbeddedAsarIntegrityValidation,FuseV1Options.OnlyLoadAppFromAsar,FuseV1Options.EnableCookieEncryption])assert(fuse[key]===49,'Required Electron fuse missing.');
const icon=execFileSync('plutil',['-extract','CFBundleIconFile','raw','-o','-',join(app,'Contents/Info.plist')],{encoding:'utf8'}).trim();const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');assert(sha(join(resources,icon))===sha(join(desktop,'assets/icons/pr5-app.icns')),'Wrong packaged app icon.');
// A relocated hardened application is launched unchanged; no fuses are relaxed.
const temporary=mkdtempSync('/tmp/ec-package-');let child;
try{
 const moved=join(temporary,'Ocean blue مرحبا','EstaCoda.app');cpSync(app,moved,{recursive:true,verbatimSymlinks:true});
 execFileSync('codesign',['--verify','--deep','--strict',moved]);
 const ptyProbe=join(temporary,'pty-probe.cjs');
 writeFileSync(ptyProbe,`const {app}=require('electron');app.whenReady().then(()=>{const pty=require(${JSON.stringify(join(moved,'Contents/Resources/app.asar/node_modules/node-pty'))});const p=pty.spawn('/bin/sh',['-c','printf PACKAGED_PTY_READY'],{cwd:'/tmp',env:{PATH:'/usr/bin:/bin',HOME:'/tmp'}});let output='';p.onData(data=>output+=data);p.onExit(({exitCode})=>app.exit(exitCode===0&&output.includes('PACKAGED_PTY_READY')?0:1));}).catch(()=>app.exit(1));setTimeout(()=>app.exit(2),10000);`);
 execFileSync(join(desktop,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),[ptyProbe],{timeout:15000,env:{HOME:temporary,PATH:'/usr/bin:/bin'},stdio:'pipe'});

 child=spawn(join(moved,'Contents/MacOS/EstaCoda'),['--user-data-dir='+join(temporary,'ui')],{env:{...process.env,HOME:temporary,CFFIXED_USER_HOME:temporary},stdio:['ignore','ignore','pipe']});let diagnostics='';child.stderr.on('data',b=>{diagnostics+=b;});await new Promise(r=>setTimeout(r,3500));assert(child.exitCode===null&&child.signalCode===null,'Relocated application exited during startup: '+child.exitCode+' / '+child.signalCode+' / '+diagnostics.slice(0,1800));
 let bridge=false;
 for(let attempt=0;attempt<40&&!bridge;attempt++){
  try{const children=execFileSync('pgrep',['-P',String(child.pid)],{encoding:'utf8'}).trim().split(/\s+/);bridge=children.some(pid=>execFileSync('ps',['-p',pid,'-o','command='],{encoding:'utf8'}).includes('/.runtime/node '));}catch{}
  if(!bridge)await new Promise(r=>setTimeout(r,250));
 }
 assert(bridge,'Relocated application did not start its owned Node bridge. '+diagnostics.slice(0,2400));
 const evidence=join(desktop,'tests/native-evidence');mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'package.json'),JSON.stringify({platform:process.platform,arch:process.arch,archiveEntries:files.length,fixtureExcluded:true,csp:true,signature:'Strict deep verification of the relocated data-and-symlink copy; excludes File Provider FinderInfo metadata',fuses:fuse,packagedIconSha256:sha(join(resources,icon)),relocatedLaunch:'unchanged hardened app; space and Arabic path; owned Node bridge observed',inspection:'Canonical UI/IPC tests run the same bundles with the development Electron binary so Playwright can attach; production fuses remain enforced.'},null,2));
 console.log('Package contents, native PTY spawn from relocated asar, CSP, fuses, requested icon and relocated hardened launch passed.');
}finally{if(child&&child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}await new Promise(r=>setTimeout(r,1700));rmSync(temporary,{recursive:true,force:true});}
