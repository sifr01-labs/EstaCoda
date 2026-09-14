import {test,expect} from '@playwright/test';
test('watches without takeover, clears busy frames, and drops late observations on close',async({page})=>{
 await page.goto('/fixture.html');
 await page.evaluate(async()=>{
  const react='/node_modules/.vite/deps/react.js',dom='/node_modules/.vite/deps/react-dom_client.js',path='/src/renderer/components/browser-watch.tsx';
  const React=(await import(react)).default,{createRoot}=(await import(dom)).default,{BrowserWatch}=await import(path);
  const host=document.querySelector('#ec-branded-workspace .ec-window')!;host.innerHTML='<div id="watch-test"></div>';
  const canvas=document.createElement('canvas');canvas.width=60;canvas.height=30;
  const state={calls:[] as string[],fail:false,defer:false,resolve:()=>{},unmount:()=>{}};
  const frame={frameId:'watch',url:'https://example.com/current',title:'Current',readiness:'complete',observedAt:'2026-09-12T12:00:00Z',image:canvas.toDataURL('image/jpeg').split(',')[1]};
  const api={inventory:async()=>({supported:true,reason:null,truncated:false,sessions:[{id:'b',tabs:[]}]}),watch:async()=>{state.calls.push('watch');if(state.fail)throw new Error('Busy');if(state.defer)return new Promise(resolve=>{state.resolve=()=>resolve(frame);});return frame;},open:async()=>{throw new Error('Must not acquire');},frame:async()=>{throw new Error('Must not control');}};
  const root=createRoot(document.getElementById('watch-test')!);state.unmount=()=>root.render(null);root.render(React.createElement(BrowserWatch,{api,workId:'session:s',controlling:false}));(window as any).watchTest=state;
 });
 await expect(page.getByRole('img',{name:'Current sanitized browser observation'})).toBeVisible();
 await page.screenshot({path:test.info().outputPath('live-browser-watch.png')});
 await page.evaluate(()=>(window as any).watchTest.fail=true);await expect(page.getByText(/Current observation unavailable/)).toBeVisible();await expect(page.getByRole('img')).toHaveCount(0);
 await page.evaluate(()=>{const s=(window as any).watchTest;s.fail=false;s.defer=true;});await expect.poll(()=>page.evaluate(()=>(window as any).watchTest.calls.length)).toBeGreaterThanOrEqual(3);
 await page.evaluate(()=>(window as any).watchTest.unmount());await expect(page.getByRole('button',{name:'Stop watching'})).toHaveCount(0);await page.evaluate(()=>(window as any).watchTest.resolve());await expect(page.getByRole('img')).toHaveCount(0);
});
