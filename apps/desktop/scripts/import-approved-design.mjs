// One-time, reviewable import of the frozen design's final CSS and exact SVG
// masks. No prototype HTML/JavaScript is shipped or executed in the renderer.
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const postcss=require(require.resolve('postcss',{paths:[require.resolve('vite')]}));
const root=new URL('../../../docs/planning/desktop-design/',import.meta.url);
const source=readFileSync(new URL('approved-prototype.html',root),'utf8');
const stylesheet=postcss.parse([...source.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n'));
// Remove superseded declarations while preserving each surviving declaration's
// cascade position (moving a base rule past a media query changes mobile layout).
const records=new Map();
stylesheet.walkRules(rule=>{
 let parent=rule.parent,condition='';while(parent.type!=='root'){condition=parent.name+':'+parent.params+'|'+condition;parent=parent.parent;}
 const key=condition+rule.selector,previous=records.get(key)??[];
 for(const node of [...rule.nodes])if(node.type==='decl'){
   for(const oldRule of previous)for(const old of [...oldRule.nodes])if(old.type==='decl'&&old.prop===node.prop){
     if(old.important&&!node.important)node.remove();else old.remove();
   }
 }
 for(const old of previous)if(!old.nodes.length)old.remove();
 records.set(key,[...previous,rule]);
});
stylesheet.walkComments(comment=>comment.remove());
stylesheet.walkDecls(decl=>{if(decl.prop==='--ec-brand-icon')decl.value='url("../assets/estacoda-eye.svg")';if(decl.prop==='--ec-brand-wordmark')decl.value='url("../assets/estacoda-wordmark.svg")';});
const tokens=postcss.root();
stylesheet.walkRules(rule=>{if(!rule.selector.includes('.ec-')&&rule.nodes.some(n=>n.type==='decl'&&n.prop.startsWith('--ec-'))){const tokenRule=rule.clone({nodes:[]});for(const node of [...rule.nodes])if(node.type==='decl'&&node.prop.startsWith('--ec-')){tokenRule.append(node.clone());node.remove();}tokens.append(tokenRule);}});
const output=new URL('../src/renderer/',import.meta.url);
writeFileSync(new URL('styles/tokens.css',output),'/* Reviewed frozen design tokens; source manifest v1. */\n'+tokens.toString()+'\n');
writeFileSync(new URL('styles/components.css',output),'/* Consolidated approved design rules; generated intentionally by import-approved-design.mjs. */\n'+stylesheet.toString()+'\n');
const masks=[...source.matchAll(/data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/g)].map(m=>Buffer.from(m[1],'base64'));
writeFileSync(new URL('assets/estacoda-eye.svg',output),masks[0]);
writeFileSync(new URL('assets/estacoda-wordmark.svg',output),masks[1]);

// Theme previews consume the same final palette values as the real surfaces.
let previews='/* Theme previews derived from the approved palette, not separate swatches. */\n';
for(const theme of ['kemet','graphite','sand']){
 const palette=new Map();
 tokens.walkRules(rule=>{if(rule.selector===`#ec-branded-workspace[data-theme="${theme}"]`)rule.walkDecls(decl=>palette.set(decl.prop,decl.value));});
 let sidebar=palette.get('--ec-nav');
 stylesheet.walkRules(rule=>{if(rule.selector===`#ec-branded-workspace[data-theme="${theme}"] .ec-sidebar`)rule.walkDecls('--ec-nav',decl=>sidebar=decl.value);});
 previews+=`#ec-branded-workspace .ec-mini[data-theme-preview="${theme}"] {${[...palette].map(([key,value])=>key+':'+value+';').join('')}--ec-mini-bg:var(--ec-bg);--ec-mini-accent:var(--ec-accent);--ec-mini-nav:${sidebar};}\n`;
}
writeFileSync(new URL('styles/theme-previews.css',output),previews);
