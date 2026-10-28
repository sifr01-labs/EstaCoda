import {describe,it,expect} from 'vitest';
import type {ActivityProjection} from '@estacoda/control-protocol';
import {imageEditPrompt,imageEditRequest,imageReferenceForRun,imageResponseText,imageRunState,isImageOutput,type ImageOutput} from './image-activity.js';
const base={id:'a',workId:'session:s',profileId:'p',timestamp:1000,sequence:1};
const image:ImageOutput={...base,kind:'artifact',label:'image.png',bytes:42,mimeType:'image/png',reference:{source:'session',ownerId:'s',artifactId:'image-id'}};
describe('image canvas projections',()=>{
 it('accepts retained raster output types only, never SVG or prose image URLs',()=>{
  expect(isImageOutput(image)).toBe(true);expect(isImageOutput({...image,mimeType:'image/svg+xml'})).toBe(false);expect(isImageOutput({...base,kind:'message',role:'assistant',text:'![image](https://remote/image.png)'})).toBe(false);
 });
 it('keeps an explicit refinement reference in the submitted message and rebuilds comparisons from same-chat history',()=>{
  const text=imageEditPrompt(image.reference,'  إضاءة أبرد  '),user={...base,kind:'message' as const,role:'user' as const,text};
  expect(imageEditRequest(text)).toEqual({artifactId:'image-id',instruction:'إضاءة أبرد'});
  expect(imageReferenceForRun({id:'run',user,items:[]},[image])).toBe(image);
  expect(imageReferenceForRun({id:'run',user,items:[]},[{...image,profileId:'another'}])).toBeUndefined();
  expect(imageReferenceForRun({id:'run',user,items:[]},[{...image,workId:'session:other'}])).toBeUndefined();
  expect(imageEditRequest('Edit artifact://image-id')).toBeNull();
 });
 it('suppresses only redundant represented-image lines and keeps unknown files and code',()=>{
  const text='Here is your image.\n\n![Generated](artifact://image-id)\n\nArtifacts:\n- artifact://image-id:image-id (image, 6 MB) - Generated image';
  expect(imageResponseText(text,[image])).toBe('Here is your image.');
  expect(imageResponseText(text,[])).toBe(text);
  const code='```md\n![Generated](artifact://image-id)\n```';expect(imageResponseText(code,[image])).toBe(code);
  const unknown='- artifact://other:other (image, 6 MB) - Other';expect(imageResponseText(unknown,[image])).toBe(unknown);
  const prose='Explain artifact://image-id and preserve the warning.';expect(imageResponseText(prose,[image])).toBe(prose);
 });
 it('uses tool identity and real run state, never animating an interrupted historical call',()=>{
  const tool:ActivityProjection={...base,kind:'tool',callId:'call',name:'image.generate',state:'running',summary:'Tool started'};
  expect(imageRunState({id:'r',items:[tool]},true)?.state).toBe('running');
  expect(imageRunState({id:'r',items:[tool]},false)?.state).toBe('interrupted');
  expect(imageRunState({id:'r',items:[tool,{...tool,id:'done',state:'failed'}]},false)?.state).toBe('failed');
  expect(imageRunState({id:'r',items:[{...tool,name:'files.read'}]},true)).toBeUndefined();
 });
});
