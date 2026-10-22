// Native operator use over the same public ledger and approval journey.
import assert from 'node:assert/strict'
import { prepaidFlow } from './prepaid.mjs'

export async function prepaidBrowser({h,owner,page,context,both,form,submit}) {
  let sequence=0
  const result=await prepaidFlow(h,owner,{onState:async state=>{
    const label=`prepaid-${sequence++}`
    for(const row of [state.row,state.units].filter(Boolean)){
      await both(`${label}-${row===state.row?'money':'units'}-ledger`,`/app/prepaid/${row.subscription}`)
      await both(`${label}-${row===state.row?'money':'units'}-upcoming`,`/app/subscriptions/${row.subscription}?preview_period=2026-03#upcoming`)
      const saved=await h.api(`prepaid/${row.subscription}`,owner)
      for(const kind of ['grant','drawdown','rollover','expiry']){
        const entry=saved.entries.find(entry=>entry.kind===kind)
        if(entry)await both(`${label}-${row===state.row?'money':'units'}-${kind}`,`/app/prepaid/${row.subscription}/entries/${encodeURIComponent(entry.id)}`)
      }
    }
    await both(`${label}-balances`,`/app/reports/credit-balances?customer=${state.row.customer}`)
    const balances=await h.api(`reports/credit-balances?customer=${state.row.customer}`,owner)
    for(const [index,entry]of balances.entries.filter(entry=>entry.prepaid).entries())await both(`${label}-balance-source-${index}`,entry.href)
    await both(`${label}-revenue`,`/app/revenue?from=2026-01&to=2026-12&customer=${state.row.customer}`)
    await both(`${label}-purchase-revenue`,`/app/revenue/${state.purchaseInvoice.id}?from=2026-01&to=2026-12`)
  }})
  await page.goto(h.origin+`/app/prepaid/${result.row.subscription}`)
  const prepare=form('prepaid.prepare')
  await prepare.locator('select[name="kind"]').selectOption('units')
  await prepare.locator('select[name="source"]').selectOption('promotion')
  await prepare.locator('select[name="meter"]').selectOption(result.row.meter)
  await prepare.locator('input[name="amount"]').fill('12.5')
  await prepare.locator('input[name="effective_date"]').fill('2026-04-01')
  await prepare.locator('input[name="expires_date"]').fill('2026-07-01')
  await prepare.locator('input[name="priority"]').fill('4')
  await prepare.locator('input[name="expiry_consent"]').check()
  await both('prepaid-native-preparation',null)
  await submit(prepare)
  const pending=(await h.api(`prepaid/${result.row.subscription}`,owner)).requests.find(request=>request.status==='pending')
  assert.ok(pending)
  const setActor=async cookie=>{
    await context.clearCookies()
    await context.addCookies(cookie.split('; ').map(value=>{const i=value.indexOf('=');return {name:value.slice(0,i),value:value.slice(i+1),url:h.origin}}))
  }
  const finance=await h.signIn('synthetic-nectar-301@example.test')
  await setActor(finance)
  await both('prepaid-native-independent-approval',`/app/prepaid/${result.row.subscription}`,async()=>{
    await page.getByText('Exact terms and drawdown order',{exact:true}).last().click()
  })
  const approve=form('prepaid.decide').filter({has:page.locator(`input[name="request"][value="${pending.id}"]`)}).filter({has:page.locator('input[name="decision"][value="approved"]')})
  await submit(approve)
  assert.equal((await h.api(`prepaid/${result.row.subscription}`,finance)).requests.find(request=>request.id===pending.id).status,'approved')
  await both('prepaid-native-approved',`/app/prepaid/${result.row.subscription}`)
  await setActor(owner)
}
