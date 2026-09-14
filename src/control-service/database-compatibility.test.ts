import {mkdtemp,mkdir,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it} from 'vitest';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {openDefaultSQLiteDatabase} from '../storage/factory.js';
import {captureWork} from './work-snapshot.js';

it.each([0,32,35,37])('reports incompatible schema %i before reading Work without migrating it',async version=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-schema-')),root=join(homeDir,'.estacoda'),path=join(root,'sessions.sqlite');
 try{
  await mkdir(root);const db=openDefaultSQLiteDatabase({path});
  if(version)db.exec(`create table schema_version(version integer primary key);insert into schema_version values (${version});`);
  db.close();
  await expect(captureWork({homeDir,profileId:'default'},new AbortController().signal)).rejects.toMatchObject({code:version>36?'-32012':'-32011'});
  const checked=openDefaultSQLiteDatabase({path,readonly:true});
  expect(checked.query<{n:number}>("select count(*) as n from sqlite_master where type='table'").get()?.n).toBe(version?1:0);
  if(version)expect(checked.query<{version:number}>('select max(version) as version from schema_version').get()?.version).toBe(version);
  checked.close();expect((await readdir(root)).some(name=>name.includes('backup'))).toBe(false);
 }finally{await rm(homeDir,{recursive:true,force:true});}
});
it('accepts current schema and a first-run home with no database',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-schema-'));
 try{
  expect((await captureWork({homeDir,profileId:'default'},new AbortController().signal)).work).toEqual([]);
  const root=join(homeDir,'.estacoda');await mkdir(root,{recursive:true});new SQLiteSessionDB({path:join(root,'sessions.sqlite')}).close();
  expect((await captureWork({homeDir,profileId:'default'},new AbortController().signal)).work).toEqual([]);
 }finally{await rm(homeDir,{recursive:true,force:true});}
});
