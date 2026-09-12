import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{expect,it}from'vitest';import{AppearanceSettings}from'./appearance-store.js';
it('persists only bounded presentation settings',()=>{const dir=mkdtempSync(join(tmpdir(),'ec-appearance-'));try{const store=new AppearanceSettings(dir);expect(store.read()).toEqual({theme:'kemet',appearance:'system',density:'comfortable',language:'en'});store.write({theme:'sand',appearance:'dark',density:'compact'});expect(store.read().theme).toBe('sand');expect(()=>store.write({theme:'sand',appearance:'dark',density:'compact',profileId:'other'})).toThrow();expect(store.read().density).toBe('compact');}finally{rmSync(dir,{recursive:true,force:true});}});

it('migrates old appearance files and persists display language without profile authority',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ec-language-'));try{
  const store=new AppearanceSettings(dir);store.write({theme:'sand',appearance:'dark',density:'compact'});expect(store.read().language).toBe('en');
  store.write({...store.read(),language:'ar'});expect(new AppearanceSettings(dir).read()).toMatchObject({language:'ar',theme:'sand'});
  for(const value of [{...store.read(),language:'fr'},{...store.read(),runtimeLanguage:'ar'},{...store.read(),profileId:'other'}])expect(()=>store.write(value)).toThrow();
  expect(store.read().language).toBe('ar');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
