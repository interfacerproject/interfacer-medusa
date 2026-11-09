// Website-only QA: no application APIs, profiles or credentials.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {mkdir}=require('node:fs/promises');
const {pathToFileURL}=require('node:url');
const {resolve}=require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true});
 const output=resolve(__dirname,'../../.tmp/review-site');
 await mkdir(output,{recursive:true});
 try {
  for(const width of [1440,390]){
   for(const kind of ['integrated','standalone']){
    const context=await browser.newContext({viewport:{width,height:900}});
    const page=await context.newPage(),errors=[],external=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>{
     const u=new URL(route.request().url());
     if(['file:'].includes(u.protocol)||['127.0.0.1','localhost'].includes(u.hostname))return route.continue();
     external.push(u.origin);return route.abort();
    });
    await page.goto(kind==='integrated'?'http://127.0.0.1:3110/en/medusa.html':pathToFileURL(resolve(__dirname,'index.html')).href);
    await page.getByRole('heading',{name:'Buying and building, written back as economic facts',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,kind+' overflow '+width);
    if(kind==='standalone'){
     await page.getByRole('button',{name:'IT',exact:true}).click();
     assert.equal(await page.evaluate(()=>document.documentElement.lang),'it');
     await page.getByRole('heading',{name:'Comprare e produrre, registrati come fatti economici',exact:true}).waitFor();
     await page.getByRole('button',{name:'Toggle theme'}).click();
     assert.ok(await page.evaluate(()=>['light','dark'].includes(document.documentElement.dataset.theme)));
    }else{
     await page.goto('http://127.0.0.1:3110/it/medusa.html');
     await page.getByRole('heading',{name:'Comprare e produrre, registrati come fatti economici',exact:true}).waitFor();
     const search=await page.request.get('http://127.0.0.1:3110/search-index.json');
     assert.ok((await search.json()).some(r=>r.chapter==='Marketplace Medusa'&&r.text.includes('outbox')));
     assert.equal((await page.request.get('http://127.0.0.1:3110/.env')).status(),404);
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,kind+' translated overflow '+width);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    await page.screenshot({path:resolve(output,kind+'-'+width+'.png')});
    console.log('PASS',kind,width,'bilingual, no overflow/errors/external requests');
    await context.close();
   }
  }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
