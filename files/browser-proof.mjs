import { createRequire } from 'node:module'
import { writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const root='/workspace/run-nectar'
const packet=process.env.HOME+'/rer-consolidation/work/sx-nectar-f25fix1/packet'
const { chromium }=createRequire(root+'/package.json')('@playwright/test')
const { runIsolated }=await import(root+'/tests/nectar/isolated.mjs')
const module=await import(root+'/tests/nectar/normalized-discount-capture.mjs')
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox','--use-mock-keychain','--password-store=basic']})
const receipt=process.argv.includes('--metered-only') ? JSON.parse(await readFile(packet+'/browser-receipt.json','utf8')) : {head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),browser:'/usr/bin/chromium',results:{},screenshots:[]}
try {
 for(const name of (process.argv.includes('--metered-only') ? ['meteredMembershipFlow'] : ['replacementDiscountFlow','meteredMembershipFlow'])) {
  await runIsolated('normalized-discount-capture',name,async()=>({harnessOptions:()=>({assets:true}),[name]:async(h,owner)=>{
   const context=await browser.newContext()
   try {
    await context.addCookies(owner.split('; ').map(part=>{const at=part.indexOf('=');return {name:part.slice(0,at),value:part.slice(at+1),url:h.origin}}))
    const page=await context.newPage()
    receipt.results[name]=await module[name](h,owner,async state=>{
     if(state.label==='metered-plan-history') {
      receipt.screenshots=receipt.screenshots.filter(row=>!row.file.includes('metered-plan-history'))
      const url=new URL(state.path,h.origin)
      const customer=await h.api('customers/'+url.searchParams.get('customer'),owner)
      const subscription=await h.api('subscriptions/'+customer.subscriptions[0].id,owner)
      state.nativePlan=subscription.items.find(item=>item.kind==='unit').price_id
      url.searchParams.delete('plan')
      state.path=url.pathname+url.search
     }
     for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1000})
      const response=await page.goto(h.origin+state.path)
      if(state.nativePlan) {
       await page.getByLabel('Plan price',{exact:true}).selectOption(state.nativePlan)
       await Promise.all([page.waitForURL(url=>url.searchParams.get('plan')===state.nativePlan),page.getByRole('button',{name:'Show month',exact:true}).click()])
      }
      const file=`proof-${width}-${state.label}.png`
      await page.screenshot({path:packet+'/'+file,fullPage:true})
      receipt.screenshots.push({file,width,status:response.status(),expectedCents:state.amount,...(state.nativePlan?{selectedNativePlan:await page.getByLabel('Plan price',{exact:true}).inputValue()}:{}),
       renderedTotal:await page.locator('main a[href="#contributions"]').allTextContents(),
       horizontalOverflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),
       sha256:createHash('sha256').update(await readFile(packet+'/'+file)).digest('hex')})
      console.log('BROWSER_PROOF',width,state.label,response.status())
     }
    })
   } finally {await context.close()}
  }}))
 }
 await writeFile(packet+'/browser-receipt.json',JSON.stringify(receipt,null,2)+'\n')
 console.log('Browser proof and both aggregate regression assertions passed on',receipt.head)
} finally {await browser.close()}
