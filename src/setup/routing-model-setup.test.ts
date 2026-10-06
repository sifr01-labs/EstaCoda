import {expect,it,vi} from 'vitest';
import {promptRoutingModelSetup} from './routing-model-setup.js';
import {normalizeRoutingConfig} from '../config/routing-config.js';
import type {Prompt} from '../cli/prompt-contract.js';
it.each(['en','ar'] as const)('asks before a paid saved-settings check without collecting changes (%s)',async locale=>{
 const values=['check','check','back'];const screens:unknown[]=[];
 const prompt=Object.assign(vi.fn(async()=>''),{select:vi.fn(async(input:any)=>{screens.push(input);return values.shift();})}) as Prompt;
 const check=vi.fn(async()=>({state:'failed' as const,reason:'authentication' as const}));
 expect(await promptRoutingModelSetup(prompt,locale,normalizeRoutingConfig({mode:'jev-assisted'}),check)).toBeUndefined();expect(check).toHaveBeenCalledTimes(1);expect(prompt).not.toHaveBeenCalled();expect(JSON.stringify(screens)).toContain(locale==='en'?'Charges may apply':'قد تُفرض رسوم');expect(JSON.stringify(screens)).toContain(locale==='en'?'Update it':'حدّثه');
});
it('cancels a connection check and allows Standard without calling TypeSafe',async()=>{
 const values=['check','back','standard'];const prompt=Object.assign(vi.fn(async()=>''),{select:vi.fn(async()=>values.shift())}) as Prompt;const check=vi.fn();
 expect(await promptRoutingModelSetup(prompt,'en',normalizeRoutingConfig({mode:'jev-assisted'}),check)).toBeUndefined();expect(await promptRoutingModelSetup(prompt,'en',normalizeRoutingConfig({mode:'jev-assisted'}),check)).toEqual({values:{routingMode:'standard'}});expect(check).not.toHaveBeenCalled();
});
