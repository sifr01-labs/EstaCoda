import {it,expect} from 'vitest';
import {executionSelectionChanges,runtimeValue,runtimeDisplay} from './runtime-settings-state.js';
import type {SettingsPage} from '@estacoda/control-protocol';
const ids=['backend','imageId',...['workspaceAccess','commandNetwork','credentialCapabilities','lifetime'].flatMap(k=>[k+'.value',k+'.requirement']),'limits.requirement',...['cpu','memoryBytes','pids','outputBytes','timeoutMs'].map(k=>'limits.value.'+k)].map(k=>'execution.'+k);
const page:SettingsPage={fields:ids.map(id=>({id,path:id.split('.'),kind:'text',section:'runtime'})),values:[],truncated:false,runtime:{effective:[{fieldId:'profile.mode',selectors:[],value:'research'}],defaults:[{fieldId:'profile.mode',selectors:[],value:'builder'}]}};
it('requires a prepared immutable image and stages a complete isolated policy',()=>{
 expect(()=>executionSelectionChanges(page,'docker')).toThrow();expect(()=>executionSelectionChanges(page,'docker','latest')).toThrow();
 const changes=executionSelectionChanges(page,'docker','sha256:'+'a'.repeat(64)),get=(id:string)=>changes.find(c=>c.fieldId==='execution.'+id)?.value;
 expect(get('commandNetwork.value')).toBe('disabled');expect(get('commandNetwork.requirement')).toBe('mandatory');expect(get('credentialCapabilities.value')).toEqual([]);expect(get('limits.requirement')).toBe('mandatory');expect(changes.length).toBeLessThanOrEqual(32);
 const host=executionSelectionChanges(page,'host');expect(host.find(c=>c.fieldId==='execution.imageId')?.value).toBeNull();expect(host.filter(c=>c.fieldId.startsWith('execution.limits.')).every(c=>c.value===null)).toBe(true);
});
it('resolves explicit resets and presents human resource units',()=>{
 expect(runtimeValue(page,[{fieldId:'profile.mode',selectors:[],value:null}],'profile.mode')).toBe('builder');expect(runtimeDisplay({fieldId:'execution.limits.value.memoryBytes',selectors:[],value:536870912})).toBe(512);expect(runtimeDisplay({fieldId:'execution.limits.value.timeoutMs',selectors:[],value:120000})).toBe(120);
});
