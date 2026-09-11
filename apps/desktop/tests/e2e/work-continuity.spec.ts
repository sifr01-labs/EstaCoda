import {test, expect, type Page} from '@playwright/test';

// Mount production components against bounded synthetic reads. No preload or
// production state is involved; this harness is excluded from release builds.
async function live(page: Page) {
  await page.goto('/fixture.html');
  await page.evaluate(async () => {
    const reactPath='/node_modules/.vite/deps/react.js', domPath='/node_modules/.vite/deps/react-dom_client.js', appPath='/src/renderer/app.tsx';
    const React=(await import(reactPath)).default, {createRoot}=(await import(domPath)).default, {App}=await import(appPath);
    document.getElementById('root')!.remove();
    const host=document.createElement('div'); host.id='review-root'; document.body.append(host);
    let profile='default', revision=1, listener:(value:unknown)=>void=()=>{};
    const pending:Array<()=>void>=[], reads:string[]=[];
    const work=(id:string)=>({id,canonicalId:id,profileId:profile,kind:'session',title:id==='old'?'Older Work':'Listed Work',status:'running',updatedAt:revision});
    const snapshot=()=>({status:'ready',profile:{id:profile,label:profile,configuration:'ready'},runtime:'ready',work:{items:[work('listed')],nextCursor:'next'},inbox:{items:[{id:'attention',profileId:profile,workId:'old',kind:'approval',title:'Old request',summary:'Review older Work',createdAt:0,approval:null}],nextCursor:null}});
    const historyPending:Array<()=>void>=[];
    const control={delay:false,fail:false,delayHistory:false,total:300,releaseHistory:()=>historyPending.splice(0).forEach(done=>done()),refresh:()=>{revision++;listener(snapshot());},flush:()=>pending.splice(0).forEach(done=>done()),reads};
    const api={platform:'darwin',onSnapshot:(fn:typeof listener)=>{listener=fn;fn(snapshot());return()=>{};},
      getWork:async(id:string)=>{const selected=work(id);if(control.delay)await new Promise<void>(resolve=>pending.push(resolve));if(control.fail)throw Error('Unavailable');return selected;},
      activity:async(_id:string,cursor?:string)=>{reads.push(cursor??'first');const [version,offset]=cursor?cursor.split(':').map(Number):[revision,0];if(version!==revision)throw Error('Stale cursor');if(control.delayHistory&&cursor)await new Promise<void>(resolve=>historyPending.push(resolve));return{items:Array.from({length:100},(_,i)=>({id:'message-'+(offset+i),kind:'message',role:'agent',text:'History '+(offset+i)})),nextCursor:offset<control.total-100?version+':'+(offset+100):null};},
      profiles:async()=>['default','other'].map(id=>({id,label:id})),switchProfile:async(id:string)=>{profile=id;listener(snapshot());},
      appearance:async()=>({theme:'kemet',appearance:'system',density:'comfortable'}),setAppearance:async()=>{},reconnect:async()=>listener(snapshot())};
    (window as any).continuity=control;
    createRoot(host).render(React.createElement(App,{adapter:{kind:'live',api,appearance:{read:api.appearance,write:api.setAppearance}}}));
  });
  await expect(page.getByRole('button',{name:'Settings',exact:true})).toBeVisible();
}

test('appearance and Work navigation retain per-Work tabs and inspector',async({page})=>{
  await page.goto('/fixture.html');
  const choose=(title:string)=>page.locator('.ec-taskbutton').filter({hasText:title}).first().click();
  await choose('Make billing retries resilient');
  await page.getByRole('button',{name:'Show inspector'}).click();
  await page.getByRole('tab',{name:'Results',exact:true}).click();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.locator('.ec-settingslink').filter({hasText:'Appearance'}).click();
  await page.getByRole('button',{name:'Graphite',exact:true}).click();
  await page.getByRole('button',{name:'Preview in Work'}).click();
  await expect(page.getByRole('tab',{name:'Results'})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('complementary',{name:'Work details'})).toBeVisible();
  await choose('Review webhook security');
  await expect(page.getByRole('button',{name:'Show inspector'})).toBeVisible();
  await choose('Make billing retries resilient');
  await expect(page.getByRole('tab',{name:'Results'})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('button',{name:'Hide inspector'})).toBeVisible();
});

test('Inbox resolves off-page Work and gives unavailable Work an explicit retry',async({page})=>{
  await live(page);
  await page.evaluate(()=>{(window as any).continuity.delay=true;});
  await page.locator('.ec-navgroup').getByRole('button',{name:/Inbox/}).click();
  await page.getByRole('button',{name:'Review request'}).click();
  await expect(page.getByRole('heading',{name:'Loading Work'})).toBeVisible();
  await page.evaluate(()=>{(window as any).continuity.flush();});
  await expect(page.getByRole('heading',{name:'Older Work'})).toBeVisible();
  await page.evaluate(()=>{const c=(window as any).continuity;c.delay=false;c.fail=true;c.refresh();});
  await expect(page.getByRole('heading',{name:'Work unavailable'})).toBeVisible();
  await expect(page.locator('.ec-newwelcome')).toHaveCount(0);
  await page.evaluate(()=>{(window as any).continuity.fail=false;});
  await page.getByRole('button',{name:'Retry Work'}).click();
  await expect(page.getByRole('heading',{name:'Older Work'})).toBeVisible();
});

test('loaded history and Results survive canonical updates using fresh cursors',async({page})=>{
  await live(page);
  await page.locator('.ec-taskbutton').filter({hasText:'Listed Work'}).click();
  await page.getByRole('button',{name:'Load more activity'}).click();
  await expect(page.getByText('History 199',{exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'Results',exact:true}).click();
  await page.evaluate(()=>{(window as any).continuity.refresh();});
  await expect.poll(()=>page.evaluate(()=>(window as any).continuity.reads.includes('2:100'))).toBe(true);
  await expect(page.getByRole('tab',{name:'Results'})).toHaveAttribute('aria-selected','true');
  await page.getByRole('tab',{name:'Activity',exact:true}).click();
  await expect(page.getByText('History 199',{exact:true})).toBeVisible();
  await expect(page.locator('section.ec-agent')).toHaveCount(200);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.locator('.ec-navgroup').getByRole('button',{name:'Work',exact:true}).click();
  await expect(page.locator('section.ec-agent')).toHaveCount(200);
});

test('late lookup cannot replace a new selection or cross a profile switch',async({page})=>{
  await live(page);
  await page.evaluate(()=>{(window as any).continuity.delay=true;});
  await page.locator('.ec-navgroup').getByRole('button',{name:/Inbox/}).click();
  await page.getByRole('button',{name:'Review request'}).click();
  await page.locator('.ec-taskbutton').filter({hasText:'Listed Work'}).click();
  await page.evaluate(()=>{(window as any).continuity.flush();});
  await expect(page.getByRole('heading',{name:'Listed Work'})).toBeVisible();
  await page.getByRole('button',{name:'Show inspector'}).click();
  await page.getByRole('tab',{name:'Results',exact:true}).click();
  await page.locator('.ec-navgroup').getByRole('button',{name:/Inbox/}).click();
  await page.getByRole('button',{name:'Review request'}).click();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByLabel('Selected profile').selectOption('other');
  await page.evaluate(()=>{(window as any).continuity.flush();});
  await expect(page.getByRole('heading',{name:'Older Work'})).toHaveCount(0);
  await page.locator('.ec-taskbutton').filter({hasText:'Listed Work'}).click();
  await expect(page.getByRole('tab',{name:'Activity'})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('button',{name:'Show inspector'})).toBeVisible();
});


test('late history pages cannot overwrite a refreshed snapshot',async({page})=>{
  await live(page);
  await page.locator('.ec-taskbutton').filter({hasText:'Listed Work'}).click();
  await expect(page.locator('section.ec-agent')).toHaveCount(100);
  await page.evaluate(()=>{(window as any).continuity.delayHistory=true;});
  await page.getByRole('button',{name:'Load more activity'}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).continuity.reads.includes('1:100'))).toBe(true);
  await page.evaluate(()=>{const c=(window as any).continuity;c.delayHistory=false;c.refresh();});
  await expect(page.getByRole('button',{name:'Load more activity'})).toBeEnabled();
  await page.evaluate(()=>{(window as any).continuity.releaseHistory();});
  await expect(page.locator('section.ec-agent')).toHaveCount(100);
  await page.getByRole('button',{name:'Load more activity'}).click();
  await expect(page.locator('section.ec-agent')).toHaveCount(200);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('activity inspection has an explicit bounded extent',async({page})=>{
  await live(page);
  await page.evaluate(()=>{(window as any).continuity.total=2100;});
  await page.locator('.ec-taskbutton').filter({hasText:'Listed Work'}).click();
  for(let count=200;count<=2000;count+=100){
    await page.getByRole('button',{name:'Load more activity'}).click();
    await expect(page.locator('section.ec-agent')).toHaveCount(count);
  }
  await expect(page.getByRole('button',{name:'First 2,000 activity items shown'})).toBeDisabled();
  expect(await page.evaluate(()=>(window as any).continuity.reads.includes('1:2000'))).toBe(false);
});
