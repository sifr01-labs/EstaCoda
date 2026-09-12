/** Real Docker target inspection and Main-owned PTY. No provider/network calls. */
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {expect} from '@playwright/test';
import {ManagedWorktrees} from '../../../src/workspaces/managed-worktrees.ts';
import {WorkspaceTrustStore} from '../../../src/security/workspace-trust-store.ts';
import {resolveProfileStateHome} from '../../../src/config/profile-home.ts';
import {probeDocker} from '../../../src/execution/docker-client.ts';
import {TerminalCapabilities} from '../../../src/control-service/terminal-capabilities.ts';
import {inspectFiles} from '../../../src/control-service/workspace-files.ts';
import {inspectDiff} from '../../../src/control-service/workspace-diff.ts';
import {inspectCoreTarget} from '../../../src/control-service/work-targets.ts';
import {DesktopTerminalControls} from '../src/main/terminal-controls.ts';
import type {DesktopConnection} from '../src/main/connection.ts';
const probe=await probeDocker();if(!probe.available||!probe.imageId)throw new Error('A prepared local Docker image is required.');
const root=await realpath(await mkdtemp(join(process.argv[2]??process.cwd(),'.ec-pr10-docker-'))),homeDir=await realpath(await mkdtemp('/tmp/ec-pr10-docker-home-')),input={homeDir,profileId:'p'},signal=new AbortController().signal;
const paths=resolveProfileStateHome(input);await mkdir(paths.profileRoot,{recursive:true});await writeFile(paths.configPath,JSON.stringify({execution:{backend:'docker',imageId:probe.imageId}}));
const store=new ManagedWorktrees(input),caps=new TerminalCapabilities(input);let terminal:DesktopTerminalControls|undefined;
try{
 execFileSync('git',['-C',root,'init','-q']);await writeFile(join(root,'inside.txt'),'Docker preview');
 const record=await store.acquireLocal(root),target={targetId:record.id,targetGeneration:1};await new WorkspaceTrustStore(input).grant(root);
 expect((await inspectFiles(input,'files.preview',{target,path:'inside.txt'},signal)).text).toBe('Docker preview');
 expect((await inspectDiff(input,'diff.list',{target},signal)).items.some(item=>item.path==='inside.txt')).toBe(true);
 const connection=Object.assign(new EventEmitter(),{state:{status:'ready',generation:1,profileId:'p'},targetRequest:async()=>inspectCoreTarget(input,target),inspectionRequest:async(method:string,params:any)=>method==='terminal.acquire'?caps.acquire(params.target,signal):method==='terminal.verify'?caps.verify(params.capabilityId,signal):caps.release(params.capabilityId)}) as unknown as DesktopConnection;
 terminal=new DesktopTerminalControls(connection,async()=>true,homeDir);const opened=await terminal.open(target);expect(opened.backend).toBe('docker');expect(store.borrowers(target.targetId)).toBe(1);
 terminal.write(opened.id,"printf 'DOCKER_TERMINAL_%s\\n' READY; printf from-terminal > terminal.txt; sleep 60 &\r");
 let output='';await expect.poll(()=>{output+=terminal!.read(opened.id).data;return output;},{timeout:10000}).toContain('DOCKER_TERMINAL_READY');
 await terminal.close(opened.id);expect(store.borrowers(target.targetId)).toBe(0);
 expect((await inspectFiles(input,'files.preview',{target,path:'terminal.txt'},signal)).text).toBe('from-terminal');
 console.log('Real Docker file/diff inspection, terminal target writes, background-job teardown and borrower release passed.');
}finally{await terminal?.dispose();caps.dispose();store.close();await rm(root,{recursive:true,force:true});await rm(homeDir,{recursive:true,force:true});}
