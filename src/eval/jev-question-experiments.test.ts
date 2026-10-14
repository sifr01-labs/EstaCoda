import {it,expect} from 'vitest';
import {experimentQuestions} from './jev-question-experiments.js';
import type {JevQuestion} from '../runtime/jev/types.js';
const questions:JevQuestion[]=[{id:'intent.repo-inspection',type:'noul',description:'Inspect repository',instructions:'Respect the request.'},{id:'skill.0',type:'noul',description:'researcher: Research sources.',instructions:'Respect prohibitions.',criteria:{true:'Relevant',false:'Unrelated'}},{id:'capability.0',type:'noul',description:'file.read: Read workspace files.',instructions:'Selection is not permission.'}];
it('leaves production baseline questions unchanged',()=>{expect(experimentQuestions(questions,'baseline')).toEqual(questions)});
it('keeps the same candidates while distinguishing specialized workflows from incidental tool use',()=>{
 const scoped=experimentQuestions(questions,'scoped-work'),fit=experimentQuestions(questions,'workflow-fit');
 expect(fit[0]).toEqual(scoped[0]);expect(fit[2]).toEqual(scoped[2]);
 expect(fit[1].id).toBe(scoped[1].id);expect(fit[1].description).toBe(scoped[1].description);
 expect(fit[1].instructions).toContain('Select complementary skills independently');
 expect(fit[1].instructions).toContain('Respect prohibitions');
 expect(questions[1]).toHaveProperty('criteria');
});
it('keeps independent candidates and authorization boundaries while making scope explicit',()=>{
 const before=structuredClone(questions),result=experimentQuestions(questions,'scoped-work');
 expect(result.map(q=>q.id)).toEqual(questions.map(q=>q.id));expect(questions).toEqual(before);
 expect(result[0].description).toContain('Excludes discussing an ability');
 expect(result[1].instructions).toContain('hypothetical ability questions');
 expect(result[2].instructions).toContain('Selection is not permission');
 for(const q of result)expect(q.instructions).toContain(q.description);
});
