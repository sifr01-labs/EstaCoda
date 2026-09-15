import {test,expect} from '@playwright/test';

test('chat connector controls show reconnect progress and intercept reload without a provider submission',async({page})=>{
 await page.goto('/fixture.html');
 await page.evaluate(async()=>{
  const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',cp='/src/renderer/components/live-composer.tsx';
  const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{LiveComposer}=await import(cp);
  const host=document.querySelector('#ec-branded-workspace .ec-window')!;host.innerHTML='<main id="test"></main>';
  const state={calls:[] as unknown[],submits:0,status:'ready',connected:false};(window as any).connectorTest=state;
  const target={targetId:'t',targetGeneration:1,label:'Project'};
  const connections={connectors:async(input:any)=>{state.calls.push(input);if(input.action==='reconnect')state.status='reconnecting';return{state:state.status,items:[{id:'example',state:state.connected?'ready':'needs_attention',toolCount:state.connected?3:0}]};}};
  (window as any).desktop={connections};
  const api={targets:async()=>({items:[target],truncated:false}),submit:async()=>{state.submits++;throw new Error('Must not send a prompt');}};
  function Harness(){const[draft,change]=React.useState({id:'d',text:'/reload-mcp',attachments:[],kind:'session',target});return React.createElement(LiveComposer,{api,work:{id:'session:s',kind:'session',target,actions:[{id:'sessions.send',enabled:true}]},draft,change,inspect:()=>{},models:()=>{},select:()=>{}});}
  createRoot(document.getElementById('test')!).render(React.createElement(Harness));
 });
 await page.getByRole('textbox',{name:'Draft guidance'}).press('Enter');
 await expect(page.getByRole('textbox',{name:'Draft guidance'})).toHaveValue('');
 await expect(page.getByRole('button',{name:'Reconnecting connectors…'})).toBeDisabled();
 expect(await page.evaluate(()=>(window as any).connectorTest.submits)).toBe(0);
 await page.evaluate(()=>{(window as any).connectorTest.status='ready';(window as any).connectorTest.connected=true;});
 await expect(page.getByText(/Ready · .*3.* tools/)).toBeVisible();
 await expect(page.getByRole('button',{name:'Reconnect connectors',exact:true})).toBeEnabled();
 await page.screenshot({path:test.info().outputPath('chat-connectors.png')});
 await page.getByRole('button',{name:'Close',exact:true}).click();
 await expect(page.getByRole('region',{name:'Connectors'})).toHaveCount(0);
});

test('Connections keeps disabled connectors distinct and scopes reconnect to a selected chat',async({page})=>{
 await page.goto('/fixture.html');
 await page.evaluate(async()=>{
  const rp='/node_modules/.vite/deps/react.js',dp='/node_modules/.vite/deps/react-dom_client.js',cp='/src/renderer/components/connector-panel.tsx';
  const React=(await import(rp)).default,{createRoot}=(await import(dp)).default,{ConnectorPanel}=await import(cp);
  const host=document.querySelector('#ec-branded-workspace .ec-window')!;host.innerHTML='<main id="test"></main>';
  createRoot(document.getElementById('test')!).render(React.createElement(ConnectorPanel,{api:{connectors:async()=>({state:'not_loaded',items:[{id:'configured',state:'not_loaded',toolCount:0},{id:'disabled',state:'disabled',toolCount:0}]})}}));
 });
 await expect(page.getByText('Choose a chat to inspect or reconnect its connectors.')).toBeVisible();
 await expect(page.getByRole('button',{name:'Reconnect connectors'})).toBeDisabled();
 await expect(page.getByText('Not connected yet')).toBeVisible();
 await expect(page.getByText('Disabled',{exact:true})).toBeVisible();
});
