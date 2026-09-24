import {it,expect,vi} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {VoiceInstallAction,VoiceInstallReview,VoiceInstallStatus,type VoiceDependencies} from './voice-dependencies.js';
const state:VoiceDependencies={items:[{id:'ddgs',version:'9.14.4',packages:['ddgs==9.14.4'],groups:[],estimatedMb:25,state:'repair_required'}],checking:false,failed:false,receipt:{operationId:'op',action:'dependency.install:ddgs:hash',state:'failed',issue:'python_required'},pending:false,installing:undefined,selected:'ddgs',refresh:vi.fn(),install:vi.fn(),open:vi.fn(),close:vi.fn()};
it('has only one install action in the expanded review and explains incompatible Python',()=>{
 expect(renderToStaticMarkup(createElement(VoiceInstallAction,{state,id:'ddgs',disabled:false}))).toBe('');
 const review=renderToStaticMarkup(createElement(VoiceInstallReview,{state}));
 expect(review).toContain('Python 3.10 or newer');expect(review.match(/Download and install/g)).toHaveLength(1);
 expect(renderToStaticMarkup(createElement(VoiceInstallStatus,{state,id:'ddgs'}))).toContain('Installation failed');
});
it('distinguishes repair from initial setup even without an operation receipt',()=>{
 expect(renderToStaticMarkup(createElement(VoiceInstallStatus,{state:{...state,receipt:null},id:'ddgs'}))).toContain('Repair required');
 expect(renderToStaticMarkup(createElement(VoiceInstallAction,{state:{...state,selected:undefined},id:'ddgs',disabled:false}))).toContain('Install…');
});
it('shows bounded installer progress without enabling a second download',()=>{
 const active={...state,pending:true,receipt:{...state.receipt!,state:'uncertain' as const,phase:'verifying' as const}};
 expect(renderToStaticMarkup(createElement(VoiceInstallStatus,{state:active,id:'ddgs'}))).toContain('Verifying installation…');
 const review=renderToStaticMarkup(createElement(VoiceInstallReview,{state:active}));expect(review).not.toContain('Download and install');expect(review).toContain('Check status');
});
