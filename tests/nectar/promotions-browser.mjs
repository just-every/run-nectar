// Browser proof of CAT-005's own screens at 1440 and 390: the catalog's coupons
// and promotion codes after the redemption journey, and a subscription page with
// a running extended trial and then its ended no-card trial.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { harness } from './harness.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { harnessOptions, promotionsFlow, trialsFlow } from './promotions.mjs'

const directory = process.env.NECTAR_EVIDENCE_DIR ?? '.evidence/promotions'
await mkdir(directory, { recursive: true })
const start = async () => {
  const h = await harness({ assets: true, ...harnessOptions() })
  assert.equal((await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Nectar Owner' } })).status, 303)
  const owner = await h.signIn(h.vars.OWNER_EMAIL)
  await h.raw('/setup', { cookie: owner, form: new URLSearchParams({ confirm: 'yes' }) })
  await h.api('business.configure', owner, { legal_name: 'Cedar Software Inc', timezone: 'America/Los_Angeles', invoice_prefix: 'CD', payment_terms_days: 30 })
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'no_tax', tax_note: 'Reviewed browser proof' })
  await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  return { h, owner }
}
let browser
const shoot = async (h, owner, label, path, text) => {
  const context = await browser.newContext()
  await context.addCookies(owner.split('; ').map(value => { const i = value.indexOf('='); return { name: value.slice(0, i), value: value.slice(i + 1), url: h.origin } }))
  const page = await context.newPage()
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 950 })
    assert.equal((await page.goto(h.origin + path)).status(), 200)
    assert.ok((await page.content()).includes(text), `${label} shows ${text}`)
    assert.equal(await page.locator('main h1').count(), 1)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label} fits ${width}`)
    const iconOnly=await page.locator('a,button,[role=button]').evaluateAll(nodes=>nodes.filter(n=>!n.textContent.trim()&&n.querySelector('svg,img')).map(n=>n.outerHTML));assert.deepEqual(iconOnly,[])
    await page.screenshot({ path: `${directory}/${width}-${label}.png`, fullPage: true })
    console.log(`BROWSER ${width} ${label}`)
  }
  await context.close()
}
async function trialForm(h,cookie,row,action) {
  const context=await browser.newContext()
  try {
    await context.addCookies(cookie.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
    const page=await context.newPage()
    await page.goto(h.origin+`/app/subscriptions/${row.subscription}`)
    const form=page.locator(`form[action="/app/do/${action}"]`)
    if(action==='trial.collection.confirm')await form.locator('[name=confirm]').check()
    else await form.locator('[name=decision]').selectOption('approved')
    await Promise.all([page.waitForNavigation({waitUntil:'load'}),form.getByRole('button').click()])
    assert.equal(new URL(page.url()).searchParams.get('error'),null)
    return (await h.api(`trial-collections?subscription=${row.subscription}`,cookie)).find(saved=>saved.id===row.authorization.id)
  }finally{await context.close()}
}
try {
  browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] })
  const first = await start()
  try { await promotionsFlow(first.h, first.owner); await shoot(first.h, first.owner, 'catalog-promotions', '/app/catalog', 'Coupons and promotion codes') } finally { await first.h.close() }
  const second = await start()
  try {
    await trialsFlow(second.h, second.owner, async state => {
      if(state.phase==='trial-collection')await shoot(second.h,second.owner,`trial-collection-${state.stage}`,`/app/subscriptions/${state.subscription}`,'First trial payment')
      if (state.phase === 'extended') await shoot(second.h, second.owner, 'subscription-trial-extended', `/app/subscriptions/${state.ext.sub}`, 'Extend trial')
      if (state.phase === 'billed') await shoot(second.h, second.owner, 'subscription-trial-ended', `/app/subscriptions/${state.none.sub}`, 'Ended unpaid')
    },{confirmTrial:async({h,owner,row})=>{const result=await trialForm(h,owner,row,'trial.collection.confirm');await shoot(h,owner,'trial-awaiting-independent-approval',`/app/subscriptions/${row.subscription}`,'First trial payment');return result},approveTrial:async({h,finance,row})=>{await shoot(h,finance,'trial-finance-approval',`/app/subscriptions/${row.subscription}`,'First trial payment');return trialForm(h,finance,row,'trial.collection.approve')}})
  } finally { await second.h.close() }
} finally { await browser?.close() }
