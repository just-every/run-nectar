import {createRequire} from 'node:module'
import {writeFile,readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
const root='/workspace/run-nectar',packet=process.env.HOME+'/rer-consolidation/work/sx-nectar-f25fix1/packet'
const {chromium}=createRequire(root+'/package.json')('@playwright/test')
const {runIsolated}=await import(root+'/tests/nectar/isolated.mjs')
const module=await import(root+'/tests/nectar/move-investigations.mjs')
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
const receipt={head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),screenshots:[]}
try {
 await runIsolated('move-investigations','moveInvestigationsFlow',async()=>({harnessOptions:()=>({assets:true,...module.harnessOptions()}),moveInvestigationsFlow:async(h,owner)=>{
  const context=await browser.newContext()
  try {
   await context.addCookies(owner.split('; ').map(part=>{const at=part.indexOf('=');return {name:part.slice(0,at),value:part.slice(at+1),url:h.origin}}))
   const page=await context.newPage(),original=h.api
   let captured=false
   h.api=async(...args)=>{
    const value=await original(...args)
    if(!captured&&args[0]==='proposal.create'&&args[2]?.assurance_case&&value?.id) {
     captured=true
     for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1000})
      const response=await page.goto(h.origin+'/app/proposals/'+value.id)
      const text=await page.locator('main').innerText(),file=`proof-${width}-unavailable-captured-mrr.png`
      await page.screenshot({path:packet+'/'+file,fullPage:true})
      receipt.screenshots.push({file,width,status:response.status(),renderedUnavailableText:text.includes('The retained contract inputs do not establish a supported normalized run rate. No normalized metric is claimed.'),horizontalOverflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),sha256:createHash('sha256').update(await readFile(packet+'/'+file)).digest('hex')})
      console.log('BROWSER_PROOF',width,'unavailable-captured-mrr',response.status())
     }
    }
    return value
   }
   await module.moveInvestigationsFlow(h,owner)
  } finally {await context.close()}
 }}))
 await writeFile(packet+'/compatibility-browser-receipt.json',JSON.stringify(receipt,null,2)+'\n')
} finally {await browser.close()}
