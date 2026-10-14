import {it,expect} from 'vitest';
import {experimentQuestions} from './jev-question-experiments.js';
import type {JevQuestion} from '../runtime/jev/types.js';
const questions:JevQuestion[]=[{id:'intent.repo-inspection',type:'noul',description:'Inspect repository',instructions:'Respect the request.'},{id:'skill.0',type:'noul',description:'researcher: Research sources.',instructions:'Respect prohibitions.',criteria:{true:'Relevant',false:'Unrelated'}},{id:'capability.0',type:'noul',description:'file.read: Read workspace files.',instructions:'Selection is not permission.'}];
it('leaves production baseline questions unchanged',()=>{expect(experimentQuestions(questions,'baseline')).toEqual(questions)});
it('keeps independent candidates and authorization boundaries while making scope explicit',()=>{
 const before=structuredClone(questions),result=experimentQuestions(questions,'scoped-work');
 expect(result.map(q=>q.id)).toEqual(questions.map(q=>q.id));expect(questions).toEqual(before);
 expect(result[0].description).toContain('Excludes discussing an ability');
 expect(result[1].instructions).toContain('hypothetical ability questions');
 expect(result[2].instructions).toContain('Selection is not permission');
 for(const q of result)expect(q.instructions).toContain(q.description);
});
