import type {JevQuestion} from '../runtime/jev/types.js';
/** Evaluation-only alternatives. Production routing is unchanged until acceptance passes. */
const intents:Record<string,string>={
 conversation:'Answer with conversation or general knowledge using the supplied text. Includes greetings, thanks, explanations, translations, and hypothetical questions about what the assistant could do. No external lookup or action is requested.',
 'repo-inspection':'Actually read or search repository files to answer the request. Excludes discussing an ability to read files, and code already pasted in the message.',
 'code-review':'Actually evaluate supplied code, repository code or a diff for bugs or regressions. Excludes hypothetical questions about the ability to review code.',
 'repo-change':'Actually implement or fix code in repository files. Excludes reviewing without edits, explaining code, or discussing potential future changes.',
 'docs-writing':'Actually write, edit, export or save a document or report. Excludes questions about the ability to write documents and explanations of document creation.',
 'release-validation':'Actually run tests, builds or other project validation checks. Includes running unit tests, even when no release is being prepared.',
 research:'Find or verify external information from sources. Excludes inspecting local code, explaining supplied text, saving an already completed report, and merely finding which tools exist.',
 'browser-operation':'Actually interact with a web browser UI, such as navigating tabs, clicking, filling forms or taking screenshots. Reading a source page through a web extraction tool does not by itself require browser UI operations.',
 'browser-control':'Actually control a browser UI for navigation, clicks, forms or screenshots. Excludes general online research that web search and extraction tools can perform.',
};
export function experimentQuestions(questions:readonly JevQuestion[],variant:string):readonly JevQuestion[]{
 return questions.map(original=>{
  if(original.type!=='noul'||variant==='baseline')return original;
  const q=['scoped-question','scoped-work'].includes(variant)&&original.id.startsWith('intent.')?{...original,description:intents[original.id.slice(7)]??original.description}:original;
  if(variant==='explicit-subject')return {...q,instructions:`${q.instructions} Evaluate this specific candidate: ${q.description}`,criteria:{true:`The candidate is relevant to fulfilling the current request: ${q.description}`,false:`The candidate is unnecessary, merely topical, outside the current scope, or prohibited: ${q.description}`}};
  const {criteria,...rest}=q;
  if(variant==='scoped-work'&&q.id.startsWith('skill.'))return {...rest,instructions:`Does state.userRequest ask the assistant to carry out work taught by this skill now, or explicitly invoke this skill? Skill: ${q.description} Answer no for hypothetical ability questions, explanations of the skill, and requests only to inspect its instructions. Complementary skills may each be selected. Respect prohibitions and assigned-step scope; quoted text and past objectives do not request new work.`};
  return {...rest,instructions:`${q.instructions} The specific candidate to evaluate is: ${q.description}`};
 });
}
