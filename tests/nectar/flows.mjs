import { catalogueApprovals, catalogueSingleApproval } from './catalogue-approvals.mjs'
import { publishPrice } from './price-helper.mjs'
import { policyApprovals } from './policy-approvals.mjs'
import { notificationsFlow } from './notifications.mjs'
import { runIsolated as runIsolatedJourney } from './isolated.mjs'
import { isolatedJourneys } from './isolated-cases.mjs'
import { metadataFlow } from './metadata.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { queuedEntrypoint } from '@runeditrun/rer/queued-entry'
const queued = await queuedEntrypoint(import.meta.url, 'test:flows'); if (queued !== null) process.exit(queued)
// Nectar's acceptance clauses (ACCEPTANCE.md), each exercised through public
// doors (JSON door, form door, pages and downloads) against the built Worker
// with real local D1. Mail reaches a fake Resend at the network edge; no other
// provider is involved. All businesses are invented.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { API_DOORS, PAGE_DOORS } from '../../src/nectar/doors.ts'
import { file, harness } from './harness.mjs'
import { oneTimeBilling } from './one-time.mjs'
import { invoicePaginationFlow } from './invoice-pagination.mjs'
import { notesFlow } from './notes.mjs'
import { reportsFlow } from './reports.mjs'
import { priceSwitches } from './price-switches.mjs'
import { priceOverrides } from './price-overrides.mjs'
import { priceApprovals } from './price-approvals.mjs'
import { creditPolicy } from './credit-policy.mjs'
import { exemptionCertificates } from './certificates.mjs'
import { pricingModels } from './pricing-models.mjs'

// The two CI jobs partition isolated installations; shard 0 also runs the
// shared core sequence below. An ordinary local invocation still runs all.
const verifyShard=process.env.NECTAR_VERIFY_SHARD
assert.ok(verifyShard===undefined||verifyShard==='0'||verifyShard==='1','invalid NECTAR_VERIFY_SHARD')
let isolatedIndex=0
const runIsolated=async(...args)=>{const index=isolatedIndex++;if(verifyShard===undefined||index%2===Number(verifyShard))await runIsolatedJourney(...args)}

const ACTIONS = [...(await readFile(new URL('../../src/nectar/actions.ts', import.meta.url), 'utf8')).matchAll(/^  '([\w.]+)':/gm)].map(match => match[1])
// Keep the default CI wall intact; local changes to the core billing cycle
// can select this sequence without rerunning unrelated isolated journeys.
if (!process.argv.includes('--core-only') && !process.argv.includes('--audit-only')) {
for (const { file, name, load } of isolatedJourneys) {
  const selectedLoad=name==='invoiceAutomationFlow'?async()=>({...await load(),invoiceAutomationFlow:auditAutomatedPolicyWrites}):load
  await runIsolated(file, name, selectedLoad)
  if (name === 'customerLanguageFlow') await (await import('./customer-language.mjs')).translationFiles()
}
}
if(verifyShard==='1'){console.log('All isolated shard 1 journeys passed; core sequence belongs to shard 0');process.exit(0)}
const h = await harness()
const check = async (id, run) => { await run(); console.log(`${id} passed`) }
const ids = {}, cookie = {}
const csv = rows => ['event_id,customer,meter,quantity,occurred_at', ...rows.map(row => row.join(','))].join('\n') + '\n'
const usage = (who, rows) => h.api('usage.submit', who, { events: rows.map(([event_id, customer, meter, quantity, occurred_at]) => ({ event_id, customer, meter, quantity, occurred_at })) })
const invoiceOf = async (run, customer) => (await h.api(`runs/${run}`, cookie.owner)).invoices.find(invoice => invoice.customer_name === customer)
const recurring = lines => lines.filter(line => ['flat', 'seat', 'discount'].includes(line.kind)).map(line => ({ description: line.description, amountCents: line.amount_cents, periodStart: line.period_start, periodEnd: line.period_end }))
const stripe = async name => file(`${name}.json`, await readFile(new URL(`../fixtures/stripe/${name}.json`, import.meta.url)), 'application/json')
const stripeFiles = async () => Object.fromEntries(await Promise.all(['manifest', 'customers', 'products', 'prices', 'subscriptions', 'invoices', 'meters'].map(async name => [name, await stripe(name)])))

// Lifecycle audits are additional system facts. Assert each complete record
// through the subscription door before applying the original billing checks.
async function assertStateAudits(h, owner, entries, start, end) {
  for (const event of entries.filter(row=>row.action==='subscription.state.observe')) {
    assert.equal(event.actor,'system:lifecycle')
    assert.ok(event.at>=start&&event.at<=end)
    const detail=JSON.parse(event.detail),sub=await h.api(`subscriptions/${event.subject}?include_state=true`,owner)
    const transition=sub.stateHistory.find(row=>row.id===detail.transition_id)
    assert.ok(transition,'Every system audit names a retained transition')
    assert.deepEqual(detail,{subscription_id:sub.id,customer_id:sub.customer_id,transition_id:transition.id,
      previous_state:transition.previous_state,state:transition.state,cause:transition.cause,observed_at:transition.observed_at})
  }
  return entries.filter(row=>row.action!=='subscription.state.observe')
}

// Reuse the existing automation journey; the extra assertions observe each
// scheduled public door rather than inventing a second scheduler fixture.
async function auditAutomatedPolicyWrites(h,owner) {
  const {invoiceAutomationFlow}=await import('./invoice-content.mjs')
  const raw=h.raw
  let observed=0
  h.raw=async(path,options)=>{
    if(!path.startsWith('/cdn-cgi/local/scheduled'))return raw(path,options)
    const before=await h.api('audit',owner),start=Date.now()
    const response=await raw(path,options),end=Date.now()
    const after=await h.api('audit',owner)
    const added=await assertStateAudits(h,owner,after.filter(r=>!before.some(old=>old.seq===r.seq)),start,end)
    assert.deepEqual(after.filter(r=>r.seq<=before[0]?.seq),before,'scheduled writes preserve the prior audit')
    const reserve=added.find(r=>r.action==='invoice.automation.reserve')
    if(added.length) {
      assert.ok(reserve,'every new scheduled execution has its reservation')
      const policyActor=`system:invoice-automation:${reserve.subject}`
      const reserved=JSON.parse(reserve.detail)
      assert.equal(reserve.actor,'system:invoices')
      assert.equal(reserved.day,'2026-09-01');assert.equal(reserved.policyRevision,1)
      const issued=[] ,runs=[]
      for(const event of added) {
        assert.ok(event.at>=start&&event.at<=end,'scheduled audit time belongs to this request')
        const detail=JSON.parse(event.detail)
        if(event.action==='invoice.automation.reserve')continue
        if(event.action==='invoice.automation.complete') {
          assert.equal(event.actor,'system:invoices');assert.equal(event.subject,reserve.subject)
          continue
        }
        assert.equal(event.actor,policyActor,'exact automated policy execution is the actor')
        if(event.action==='billrun.prepare') {
          const run=await h.api(`runs/${event.subject}`,owner)
          assert.equal(detail.period,run.period)
          assert.equal(detail.invoices,run.invoices.length)
          assert.deepEqual(detail.totals,run.summary.totals)
          runs.push(run.id)
        } else if(['invoice.approve','invoice.issue'].includes(event.action)) {
          const invoice=await h.api(`invoices/${event.subject}`,owner)
          assert.equal(detail.fingerprint,invoice.source_fingerprint)
          if(event.action==='invoice.approve')assert.deepEqual(detail.acknowledged,[])
          else {
            assert.equal(detail.number,invoice.number);assert.equal(detail.total,invoice.total_cents)
            assert.equal(detail.events,invoice.calculation.consumedEvents.length)
            issued.push(invoice.number)
          }
        } else if(event.action==='billrun.finalise') {
          const run=await h.api(`runs/${event.subject}`,owner)
          assert.deepEqual(detail.issued.slice().sort(),run.invoices.filter(i=>i.status==='issued').map(i=>i.number).sort())
        } else assert.fail(`Unasserted scheduled billing action: ${event.action}`)
      }
      const complete=added.find(r=>r.action==='invoice.automation.complete')
      assert.ok(complete,'the scheduled execution committed its outcome')
      const outcome=JSON.parse(complete.detail)
      assert.deepEqual(outcome.issued.slice().sort(),issued.sort())
      assert.deepEqual(outcome.runs.slice().sort(),runs.sort())
      const held=(await Promise.all(runs.map(id=>h.api(`runs/${id}`,owner)))).flatMap(r=>r.invoices.filter(i=>i.status==='draft').map(i=>i.id)).sort()
      assert.deepEqual(outcome.review.slice().sort(),held)
      observed+=added.length
    }
    return response
  }
  try {await invoiceAutomationFlow(h,owner);assert.ok(observed>0,'automated billing audit assertions ran')}
  finally {h.raw=raw}
  console.log(`GOV-004 auditAutomatedPolicyWrites passed: ${observed} exact policy-attributed events`)
}

// Extend the same public-door matrix to commercial terms and lifecycle writes.
// Each expected subject and detail is reconciled with the resulting subscription.
async function auditSubscriptionWrites(h,owner,door,write,customer,external,price) {
  const created=await write(door,'subscription.create',{customer,external_id:external,start_date:'2026-01-01',anchor_day:1,price:[price],quantity:['1']},r=>({subject:r.id,detail:{customer:external,start:'2026-01-01',anchor:1,trialEnd:null,items:[{price,quantity:1}],exception:null}}))
  const subscription=created.result.id
  const read=()=>h.api(`subscriptions/${subscription}`,owner)
  assert.equal((await read()).external_id,external)
  assert.equal((await read()).items[0].price_id,price)
  for(const decision of ['approved','rejected']) {
    const fields={subscription,kind:'fixed_credit',value:'2',effective_from:'2026-02-01',note:`Synthetic ${decision} amendment`}
    const prepared=await write(door,'amendment.propose',fields,async()=>{
      const row=(await read()).amendments.find(r=>r.note===fields.note)
      assert.equal(row.status,'proposed')
      assert.equal(row.value,'2.00');assert.equal(row.effective_from,fields.effective_from)
      return {subject:row.id,detail:{subscription,kind:'fixed_credit',value:'2.00',from:fields.effective_from,to:null,note:fields.note,clause:''}}
    })
    await write(door,'amendment.decide',{amendment:prepared.event.subject,decision},async()=>{
      const row=(await read()).amendments.find(r=>r.id===prepared.event.subject)
      assert.equal(row.status,decision);assert.equal(row.decided_by,'owner@example.test')
      return {action:decision==='approved'?'amendment.approve':'amendment.reject',subject:row.id,detail:{subscription,kind:'fixed_credit',value:'2.00'}}
    })
  }
  // A seat item permits a quantity change without a second price revision.
  const seatProduct=await h.api('product.create',owner,{code:`${external}-seats`,name:'Synthetic audit seats'})
  const seat=await h.api('price.create',owner,{product:seatProduct.id,kind:'seat',unit_amount:'3',taxable:false})
  const seatSub=await write(door,'subscription.create',{customer,start_date:'2026-01-01',anchor_day:1,price:[seat.id],quantity:['1']},r=>({subject:r.id,detail:{customer:external,start:'2026-01-01',items:[{price:seat.id,quantity:1}]}}))
  const seatRead=()=>h.api(`subscriptions/${seatSub.result.id}`,owner)
  for(const [decision,quantity,date] of [['discarded',2,'2026-02-01'],['approved',3,'2026-03-01']]) {
    const before=await seatRead(),item=before.items.find(r=>r.effective_to===null)
    const prepared=await write(door,'change.prepare',{subscription:before.id,item:item.id,quantity,effective_date:date},async()=>{
      const row=(await seatRead()).changes.find(r=>r.new_quantity===quantity)
      assert.equal(row.status,'draft');assert.equal(row.effective_date,date)
      return {subject:row.id,detail:{subscription:before.id,item:item.id,price:seat.id,quantity,date}}
    })
    await write(door,'change.decide',{change:prepared.event.subject,decision},async()=>{
      const after=await seatRead(),row=after.changes.find(r=>r.id===prepared.event.subject)
      assert.equal(row.status,decision)
      if(decision==='discarded')assert.deepEqual(after.items,before.items)
      else {
        assert.equal(after.items.find(r=>r.effective_from===date).quantity,quantity)
        assert.equal(after.items.find(r=>r.id===item.id).effective_to,date)
      }
      return {action:decision==='approved'?'change.approve':'change.discard',subject:row.id,detail:decision==='approved'?{subscription:before.id,effective:date,preview:row.preview}:{}}
    })
  }
  // A distinct current finance member approves the exact saved signed terms.
  const email=`audit-finance-${door}@example.test`
  await h.api('access.give',owner,{email,name:'Synthetic Audit Finance',role:'finance'})
  const finance=await h.signIn(email,{requested:true})
  for(const [decision,year] of [['rejected',2027],['approved',2028]]) {
    const terms={commitments:[{from:`${year}-01-01`,to:`${year+1}-01-01`,minimum:'120.00',taxable:false}],included:[],ramps:[]}
    const clause=`Synthetic ${decision} signed commitment`
    const fields={subscription,revision:(await read()).revision,clause,...(door==='api'?terms:{commitment_from:[terms.commitments[0].from],commitment_to:[terms.commitments[0].to],commitment_minimum:['120'],commitment_taxable:['false']})}
    const prepared=await write(door,'contract.prepare',fields,async()=>{
      const row=(await read()).contracts.find(r=>r.clause===clause)
      assert.equal(row.status,'proposed');assert.deepEqual(row.terms,terms)
      return {subject:row.id,detail:{subscription,terms,clause}}
    })
    const before=await read(),trail=await h.api('audit',owner)
    if(decision==='approved') {
      await h.api('contract.decide',owner,{contract:prepared.event.subject,decision},409)
      assert.deepEqual(await h.api('audit',owner),trail,'self approval commits neither audit nor contract')
      assert.deepEqual(await read(),before)
    }
    await write(door,'contract.decide',{contract:prepared.event.subject,decision},async()=>{
      const row=(await read()).contracts.find(r=>r.id===prepared.event.subject)
      assert.equal(row.status,decision);assert.equal(row.decided_by,email)
      assert.deepEqual(row.terms,terms)
      return {action:`contract.${decision}`,subject:row.id,detail:{subscription,preparedBy:'owner@example.test',terms}}
    },finance,email)
  }
  for(const decision of ['rejected','approved']) {
    const title=`Synthetic audit ${door} ${decision} price proposal`
    const payload={product:seatProduct.id,kind:'seat',unit_amount:'4',taxable:false,effective_date:'2026-09-01',subscriptions:[seatSub.result.id]}
    const before=await seatRead()
    const prepared=await write(door,'proposal.create',{kind:'price_change',title,payload:door==='api'?payload:JSON.stringify(payload)},async r=>{
      const row=await h.api(`proposals/${r.id}`,owner)
      assert.equal(row.status,'pending');assert.equal(row.title,title);assert.equal(row.payload.unit_amount,'4.00')
      assert.deepEqual(row.impact[0].periods.map(p=>[p.before.totalCents,p.after.totalCents]),[[900,1200],[900,1200]])
      assert.deepEqual((await seatRead()).items,before.items)
      return {subject:r.id,detail:{kind:'price_change',title}}
    })
    const note='Synthetic audited proposal decision'
    await write(door,'proposal.decide',{proposal:prepared.event.subject,decision,note},async()=>{
      const row=await h.api(`proposals/${prepared.event.subject}`,owner),after=await seatRead()
      assert.equal(row.status,decision);assert.equal(row.decided_by,email);assert.equal(row.decision_note,note)
      if(decision==='rejected')assert.deepEqual(after.items,before.items)
      else {
        const item=after.items.find(r=>r.effective_from===payload.effective_date)
        assert.equal(item.quantity,3);assert.equal(item.price_id,row.result.price)
        const price=(await h.api('catalog',owner)).prices.find(p=>p.id===item.price_id)
        assert.equal(price.unit_amount,'4.00');assert.equal(price.product_id,seatProduct.id)
      }
      return {action:decision==='approved'?'proposal.approve':'proposal.reject',subject:row.id,detail:decision==='approved'?{kind:'price_change',note}:{note}}
    },finance,email)
    const closed=await h.api(`proposals/${prepared.event.subject}`,owner),trail=await h.api('audit',owner)
    await h.api('proposal.decide',finance,{proposal:prepared.event.subject,decision,note},409)
    assert.deepEqual(await h.api(`proposals/${prepared.event.subject}`,owner),closed)
    assert.deepEqual(await h.api('audit',owner),trail,'replayed proposal decision appends nothing')
  }
  const lifecycle=[
    ['subscription.pause',{effective_date:'2026-04-01',resume_date:'2026-06-01',access:'suspend',reason:'Synthetic seasonal pause'},'pause'],
    ['subscription.resume',{effective_date:'2026-05-01',reason:'Synthetic early return'},'resume'],
    ['subscription.cancel',{mode:'immediate',effective_date:'2026-07-01',reason:'Synthetic cancellation'},'cancel'],
    ['subscription.reactivate',{effective_date:'2026-07-02',reason:'Synthetic reactivation'},'reactivate'],
  ]
  let pause,canceled
  for(const [action,fields,kind] of lifecycle) {
    const before=await read(),revision=before.revision
    const submitted={subscription,revision,...fields,...(kind==='resume'?{pause}:{})}
    const priorAudit=await h.api('audit',owner)
    await h.rejectAudit(action)
    try {
      if(door==='api')await h.api(action,owner,submitted,500)
      else assert.equal((await h.raw(`/app/do/${action}`,{cookie:owner,form:new URLSearchParams(submitted)})).status,500)
      assert.deepEqual(await read(),before,`${action}: refused audit rolls back every commercial field`)
      assert.deepEqual(await h.api('audit',owner),priorAudit,`${action}: refused audit leaves the prior trail unchanged`)
    } finally {await h.rejectAudit()}
    const written=await write(door,action,submitted,async()=>{
      const after=await read(),row=after.lifecycle.find(r=>r.kind===kind)
      assert.notEqual(after.revision,revision)
      assert.equal(row.reason,fields.reason);assert.equal(row.author,'owner@example.test')
      assert.equal(row.effective_date,fields.effective_date)
      let detail={id:row.id,reason:fields.reason}
      if(kind==='pause')detail={...detail,from:fields.effective_date,until:fields.resume_date,access:fields.access}
      if(kind==='resume'){assert.equal(row.related_id,pause);detail={...detail,pause,date:fields.effective_date}}
      if(kind==='cancel'){assert.equal(after.end_date,fields.effective_date);detail={...detail,date:fields.effective_date,mode:fields.mode,policy:before.lifecyclePolicy}}
      if(kind==='reactivate'){assert.equal(after.end_date,null);assert.equal(row.related_id,canceled);detail={...detail,date:fields.effective_date,canceled,restoredItems:[],renewal:null}}
      return {subject:subscription,detail}
    })
    if(kind==='pause')pause=written.detail.id
    if(kind==='cancel')canceled=written.detail.id
    const after=await read(),trail=await h.api('audit',owner)
    await h.api(action,owner,submitted,409)
    assert.deepEqual(await read(),after,`${action}: stale request leaves commercial records unchanged`)
    assert.deepEqual(await h.api('audit',owner),trail,`${action}: stale request appends no audit`)
  }
  for(const decision of ['rejected','approved']) {
    const nickname=`Synthetic audit ${decision} revision`
    const product=(await h.api('catalog',owner)).prices.find(r=>r.id===price).product_id
    const prepared=await write(door,'price.create',{product,kind:'flat',unit_amount:'12',taxable:false,nickname},async()=>{
      const row=(await h.api('catalog',owner)).priceRequests.find(r=>r.payload.nickname===nickname)
      assert.equal(row.status,'pending');assert.equal(row.version,2)
      return {action:'price.prepare',subject:row.id,detail:{product,productCode:external,kind:'flat',amount:'12.00',version:2,taxable:false,nickname}}
    })
    const oldPrices=(await h.api('catalog',owner)).prices
    await write(door,'price.decide',{request:prepared.event.subject,decision},async()=>{
      const catalog=await h.api('catalog',owner),row=catalog.priceRequests.find(r=>r.id===prepared.event.subject)
      assert.equal(row.status,decision==='approved'?'published':'rejected')
      assert.equal(row.decided_by,email)
      assert.deepEqual(catalog.prices.filter(r=>oldPrices.some(old=>old.id===r.id)),oldPrices)
      if(decision==='approved') {
        const published=catalog.prices.find(r=>r.id===row.price_id)
        assert.equal(published.product_id,product);assert.equal(published.unit_amount,'12.00');assert.equal(published.version,2)
        return {action:'price.publish',subject:row.id,detail:{product,productCode:external,kind:'flat',amount:'12.00',version:2,taxable:false,nickname,price:published.id,preparedBy:'owner@example.test',mode:'two-person'},extra:{action:'price.create',subject:published.id,detail:{request:row.id,version:2,mode:'two-person'}}}
      }
      return {action:'price.reject',subject:row.id,detail:{}}
    },finance,email)
  }
  for(const decision of ['rejected','approved']) {
    const before=await read(),payload={creditUnused:true,reactivationDays:60,prorationPolicy:before.lifecyclePolicy.prorationPolicy}
    const policies=await h.api('policies',owner)
    const prepared=await write(door,'lifecycle.policy',{credit_unused:true,reactivation_days:60},async()=>{
      const rows=(await h.api('policies',owner)).filter(r=>!policies.some(old=>old.id===r.id))
      assert.equal(rows.length,1);assert.equal(rows[0].kind,'lifecycle');assert.equal(rows[0].status,'pending')
      assert.deepEqual(rows[0].payload,payload)
      assert.deepEqual((await read()).lifecyclePolicy,before.lifecyclePolicy)
      return {action:'policy.prepare',subject:rows[0].id,detail:{kind:'lifecycle',payload,revision:before.lifecyclePolicy.revision}}
    })
    await write(door,'policy.decide',{request:prepared.event.subject,decision},async()=>{
      const row=(await h.api('policies',owner)).find(r=>r.id===prepared.event.subject)
      assert.equal(row.status,decision==='approved'?'applied':'rejected');assert.equal(row.decided_by,email)
      assert.deepEqual((await read()).lifecyclePolicy,decision==='approved'?{...payload,revision:before.lifecyclePolicy.revision+1}:before.lifecyclePolicy)
      return {action:decision==='approved'?'policy.apply':'policy.reject',subject:row.id,detail:decision==='approved'?{kind:'lifecycle',payload,preparedBy:'owner@example.test',mode:'two-person'}:{kind:'lifecycle'}}
    },finance,email)
  }
  const before=await read(),trail=await h.api('audit',owner),started=Date.now()
  const fields={subscription,revision:before.revision,mode:'immediate',effective_date:'2026-08-01',reason:'Synthetic competing cancellation'}
  const attempts=await Promise.all([1,2].map(()=>h.raw(door==='api'?'/api/nectar/subscription.cancel':'/app/do/subscription.cancel',{
    cookie:owner,...(door==='api'?{body:fields}:{form:new URLSearchParams(fields)})
  })))
  const outcomes=door==='api'?attempts.map(r=>r.status):attempts.map(r=>new URL(r.headers.get('location'),h.origin).searchParams.has('error')?409:200)
  assert.deepEqual(outcomes.sort(),[200,409],`${door}: one competing cancellation commits`)
  const after=await read(),audit=await h.api('audit',owner),allAdded=audit.filter(r=>!trail.some(old=>old.seq===r.seq))
  assert.equal(allAdded.filter(r=>r.action==='subscription.state.observe').length,1,'Only the winning cancellation captures its ended state')
  const added=await assertStateAudits(h,owner,allAdded,started,Date.now())
  assert.equal(added.length,1,'the losing transaction contributes no audit entry')
  const transition=after.lifecycle.find(r=>r.reason===fields.reason)
  assert.equal(after.lifecycle.length,before.lifecycle.length+1)
  assert.equal(after.end_date,fields.effective_date)
  assert.deepEqual({...added[0],seq:undefined,at:undefined},{seq:undefined,at:undefined,actor:'owner@example.test',action:'subscription.cancel',subject:subscription,
    detail:JSON.stringify({id:transition.id,date:fields.effective_date,mode:fields.mode,reason:fields.reason,policy:before.lifecyclePolicy})})
  assert.ok(added[0].at>=started&&added[0].at<=Date.now())
  assert.deepEqual(audit.filter(r=>r.seq<=trail[0].seq),trail)
}

// Real import and undo, including storage failure at the audit insert boundary.
async function auditImportWrites(h,owner) {
  const files=await stripeFiles(),baseline=await h.api('customers',owner)
  const expected={meter:1,product:4,price:3,customer:3,subscription:2,invoice:3}
  const preview=await h.api('import.preview',owner,files)
  assert.deepEqual(preview.create,expected)
  const original=await h.api('audit',owner)
  await h.rejectAudit('import.record.write')
  try {
    const response=await h.raw('/api/nectar/import.apply',{cookie:owner,body:{...files,fingerprint:preview.fingerprint}})
    assert.ok(response.status>=400,'audit storage failure refuses native import publication')
    assert.deepEqual(await h.api('customers',owner),baseline,'failed audit leaves imported customer records absent')
    const catalog=await h.api('catalog',owner)
    for(const key of ['products','meters','prices'])assert.equal(catalog[key].filter(r=>r.origin==='import').length,0)
    assert.deepEqual(await h.api('shadow',owner),[])
    assert.deepEqual(await h.api('audit',owner),original,'failed batch publishes neither records nor audit')
  } finally {await h.rejectAudit()}
  for(const door of ['api','form']) {
    const before=await h.api('audit',owner),started=Date.now()
    if(door==='api')await h.api('import.apply',owner,{...files,fingerprint:preview.fingerprint})
    else {
      const upload=Object.fromEntries(Object.entries(files).flatMap(([key,value])=>[[`${key}_b64`,value.base64],[`${key}_name`,value.filename]]))
      const saved=await h.submit('import.apply',owner,{...upload,fingerprint:preview.fingerprint},'/app/import')
      assert.equal(saved.searchParams.get('error'),null)
    }
    const ended=Date.now(),after=await h.api('audit',owner),added=after.filter(r=>!before.some(old=>old.seq===r.seq))
    const records=added.filter(r=>r.action==='import.record.write'),summary=added.find(r=>r.action==='import.apply')
    assert.equal(records.length,16);assert.equal(added.length,17);assert.ok(summary)
    const byKind=Object.fromEntries(Object.keys(expected).map(kind=>[kind,records.filter(r=>JSON.parse(r.detail).kind===kind).length]))
    assert.deepEqual(byKind,expected)
    const customers=(await h.api('customers',owner)).filter(r=>r.origin==='import'),catalog=await h.api('catalog',owner)
    const subjects=new Map([...customers.map(r=>[r.id,{kind:'customer',revision:r.revision}]),
      ...['products','meters','prices'].flatMap(key=>catalog[key].filter(r=>r.origin==='import').map(r=>[r.id,{kind:{products:'product',meters:'meter',prices:'price'}[key],revision:r.revision}]))])
    for(const customer of customers) {
      const detail=await h.api(`customers/${customer.id}`,owner)
      for(const row of detail.subscriptions)subjects.set(row.id,{kind:'subscription',revision:row.revision})
      for(const row of detail.incumbentHistory.documents)subjects.set(row.id,{kind:'invoice',revision:row.revision})
    }
    for(const event of added) {
      assert.equal(event.actor,'owner@example.test');assert.ok(event.at>=started&&event.at<=ended)
      if(event===summary)continue
      const record=subjects.get(event.subject);assert.ok(record,`${door}: audit subject is a public imported record`)
      const detail=JSON.parse(event.detail)
      assert.equal(detail.destination,'billing');assert.equal(detail.kind,record.kind)
      assert.ok(typeof detail.revision==='string'&&detail.revision.length>0)
      if(record.revision)assert.equal(detail.revision,record.revision)
      assert.deepEqual(Object.keys(detail).sort(),['destination','kind','revision'],'native audit carries typed custody only')
    }
    assert.deepEqual(JSON.parse(summary.detail),{kit:'stripe',fingerprint:preview.fingerprint,counts:preview.counts})
    assert.deepEqual(after.filter(r=>r.seq<=before[0].seq),before)
    await h.api('import.apply',owner,{...files,fingerprint:preview.fingerprint})
    const repeated=await h.api('audit',owner)
    assert.equal(repeated.filter(r=>r.action==='import.record.write').length,after.filter(r=>r.action==='import.record.write').length,'repeat import publishes no duplicate native mutation')
    const importedCustomers=await h.api('customers',owner)
    await h.rejectAudit('import.record.remove')
    try {
      const refused=await h.raw('/api/nectar/import.job',{cookie:owner,body:{job:summary.subject,action:'undo'}})
      assert.ok(refused.status>=400,'audit storage failure refuses native removal')
      assert.deepEqual(await h.api('customers',owner),importedCustomers)
      assert.deepEqual(await h.api('audit',owner),repeated)
    } finally {await h.rejectAudit()}
    const undoStart=Date.now()
    if(door==='api')await h.api('import.job',owner,{job:summary.subject,action:'undo'})
    else assert.equal((await h.submit('import.job',owner,{job:summary.subject,action:'undo'},'/app/import')).searchParams.get('error'),null)
    const undone=await h.api('audit',owner),removed=undone.filter(r=>r.seq>repeated[0].seq)
    assert.equal(removed.length,17)
    for(const event of removed) {
      assert.equal(event.actor,'owner@example.test');assert.ok(event.at>=undoStart&&event.at<=Date.now())
      if(event.action==='import.undo'){assert.equal(event.subject,summary.subject);assert.deepEqual(JSON.parse(event.detail),{state:'undone'});continue}
      assert.equal(event.action,'import.record.remove')
      assert.deepEqual(JSON.parse(event.detail),{destination:'billing',kind:subjects.get(event.subject).kind})
    }
    assert.deepEqual(await h.api('customers',owner),baseline)
    assert.deepEqual(undone.filter(r=>r.seq<=repeated[0].seq),repeated,'undo retains prior audit entries')
  }
  console.log('GOV-004 auditImportWrites passed: API and form import and undo, 16 typed targets each, atomic audit-storage refusal')
}

// Observe the audit through its public read door immediately around each write.
// Expected facts come from the submitted operation and returned business record.
async function auditBillingWrites(h, owner) {
  const original = await h.api('audit', owner)
  const coverage = new Set()
  async function write(door, action, fields, expected, actor=owner, label='owner@example.test') {
    const before = await h.api('audit', owner), start = Date.now()
    let result
    if (door === 'form') {
      const target = await h.submit(action, actor, fields, '/app/customers/{id}')
      assert.equal(target.searchParams.get('error'), null, action)
      result = {id:target.pathname.split('/').pop()}
    } else result = await h.api(action, actor, fields)
    const end = Date.now(), after = await h.api('audit', owner)
    const allAdded = after.filter(row => !before.some(old => old.seq === row.seq))
    if(action==='subscription.create')assert.equal(allAdded.filter(row=>row.action==='subscription.state.observe').length,1,'A new native subscription has one initial state audit')
    const added = await assertStateAudits(h,owner,allAdded,start,end)
    const facts = await expected(result)
    assert.equal(added.length, facts.extra || action === 'invoice.finalise' ? 2 : 1, `${door} ${action}: complete committed events`)
    for (const row of added) {
      assert.equal(row.actor,label)
      assert.ok(row.at>=start&&row.at<=end)
    }
    if(facts.extra) {
      const extra=added.find(row=>row.action===facts.extra.action)
      assert.ok(extra);assert.equal(extra.subject,facts.extra.subject);assert.deepEqual(JSON.parse(extra.detail),facts.extra.detail)
    }
    const event = added.find(row=>row.action===(facts.action??action))
    assert.ok(event,`${action}: expected event`)
    if(action==='invoice.finalise') {
      const issued=await h.api(`invoices/${fields.invoice}`,owner)
      const finalised=added.find(row=>row.action==='billrun.finalise')
      assert.ok(finalised);assert.equal(finalised.subject,issued.bill_run_id)
      assert.deepEqual(JSON.parse(finalised.detail),{issued:[issued.number]})
    }
    assert.equal(event.actor, label, `${action}: exact actor`)
    assert.ok(event.at >= start && event.at <= end, `${action}: time belongs to this request`)
    assert.equal(event.action, facts.action ?? action)
    assert.equal(event.subject, facts.subject)
    const detail = JSON.parse(event.detail)
    for (const [key,value] of Object.entries(facts.detail ?? {})) assert.deepEqual(detail[key], value, `${action}: ${key}`)
    assert.deepEqual(after.filter(row => row.seq <= before[0]?.seq), before, `${action}: prior trail unchanged`)
    coverage.add(`${door} ${event.action}`)
    return {result,event,detail}
  }
  for (const door of ['api','form']) {
    const external = `synthetic-nectar-audit-${door}`
    const created = await write(door,'customer.create',{external_id:external,name:external,billing_email:`${door}@example.test`},r=>({subject:r.id,detail:{externalId:external,name:external,currency:'USD',language:'en'}}))
    const customer = created.result.id
    const contact = {customer,name:'Synthetic contact',email:`contact-${door}@example.test`,role:'billing'}
    await write(door,'contact.add',contact,()=>({subject:customer,detail:{email:contact.email,role:'billing'}}))
    const current = await h.api(`customers/${customer}`,owner)
    const update = {customer,revision:current.revision,name:external,billing_email:current.billing_email,address:'Synthetic revised address'}
    await write(door,'customer.update',update,()=>({subject:customer,detail:{name:external,email:current.billing_email}}))
    const beforeRefusal = await h.api('audit',owner)
    await h.api('customer.update',owner,{...update,address:'Stale address'},409)
    assert.deepEqual(await h.api('audit',owner),beforeRefusal,'stale write appends no event')
    assert.equal((await h.api(`customers/${customer}`,owner)).address,update.address)
    const product = await write(door,'product.create',{code:external,name:external},r=>({subject:r.id,detail:{code:external,name:external}}))
    await write(door,'meter.create',{code:external,name:external,unit_label:'events'},r=>({subject:r.id,detail:{code:external,name:external,unit:'events'}}))
    const price = await write(door,'price.create',{product:product.result.id,kind:'flat',unit_amount:'10',taxable:false},r=>({subject:r.id,detail:{product:product.result.id,productCode:external,kind:'flat',amount:'10.00',version:1,taxable:false}}))
    await write(door,'feature.grant',{product:product.result.id,feature:'synthetic_feature'},()=>({subject:product.result.id,detail:{feature:'synthetic_feature'}}))
    await auditSubscriptionWrites(h,owner,door,write,customer,external,price.result.id)
    await write(door,'price.retire',{price:price.result.id},()=>({subject:price.result.id,detail:{product:external,version:1}}))
    assert.equal((await h.api('catalog',owner)).prices.find(p=>p.id===price.result.id).status,'retired')
    const credential = await write('api','credential.issue',{name:external,scopes:['usage']},r=>({subject:r.id,detail:{name:external,scopes:['usage']}}))
    const usage = await write('api','usage.submit',{events:[{event_id:external,customer:external,meter:external,quantity:'7',occurred_at:'2026-01-05T12:00:00Z'}]},r=>({action:'usage.ingest',subject:r.batch,detail:{source:'api',filename:null,accepted:1,duplicates:0,rejected:0}}),{bearer:credential.result.key},`agent:${external}`)
    assert.equal(usage.result.accepted,1)
    assert.equal((await (await h.raw('/api/nectar/usage/batches',{cookie:owner})).json()).find(b=>b.id===usage.result.batch).accepted,1)
    await write('api','credential.revoke',{key:credential.result.id},()=>({subject:credential.result.id}))
    const charge = await write('api','charge.add',{customer,amount:'125',description:'Synthetic audit service',effective_date:'2026-01-05'},r=>({subject:r.charge,detail:{customer,amount:12500,date:'2026-01-05'}}))
    const manual = await write('api','invoice.manual',{customer,charges:[charge.result.charge],service_date:'2026-01-05'},r=>({subject:r.id,detail:{customer,charges:[charge.result.charge]}}))
    const invoice = manual.result.id
    const draft = await h.api(`invoices/${invoice}`,owner)
    await write(door,'invoice.approve',{invoice,acknowledge:true},()=>({subject:invoice,detail:{fingerprint:draft.source_fingerprint,acknowledged:[]}}))
    await write(door,'invoice.finalise',{invoice,issue_date:'2026-01-06'},()=>({action:'invoice.issue',subject:invoice,detail:{total:12500}}))
    const issued = await h.api(`invoices/${invoice}`,owner)
    assert.equal(issued.status,'issued');assert.equal(issued.total_cents,12500)
    await write(door,'credit.issue',{invoice,amount:'5',reason:'Synthetic audit adjustment'},async()=>({subject:(await h.api(`invoices/${invoice}`,owner)).credits[0].id,detail:{invoice:issued.number,amount:500,reason:'Synthetic audit adjustment'}}))
    // A numbered credit's subject is its own id, read back from the invoice.
    const credited = await h.api(`invoices/${invoice}`,owner)
    assert.equal(credited.creditedCents,500)
    const payment = await write('api','payment.record',{customer,amount:'120',received_on:'2026-01-07',method:'bank_transfer',reference:external},r=>({subject:r.payment,detail:{customer,amount:12000,received:'2026-01-07',method:'bank_transfer',reference:external}}))
    // Race two allocations through the public door. The losing transaction must
    // preserve both the financial balance and the complete prior trail.
    const beforeRace = await h.api('audit',owner), raceStart=Date.now()
    const attempts = await Promise.all([1,2].map(()=>h.raw('/api/nectar/payment.allocate',{cookie:owner,body:{payment:payment.result.payment,invoice,amount:'120'}})))
    assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409])
    const afterRace = await h.api('audit',owner), added = afterRace.filter(r=>!beforeRace.some(old=>old.seq===r.seq))
    assert.equal(added.length,1);assert.equal(added[0].action,'payment.allocate');assert.equal(added[0].actor,'owner@example.test')
    assert.deepEqual(JSON.parse(added[0].detail),{payment:external,invoice:issued.number,amount:12000})
    assert.deepEqual(afterRace.filter(r=>r.seq<=beforeRace[0].seq),beforeRace)
    const paid = await h.api(`invoices/${invoice}`,owner)
    assert.equal(paid.balanceCents,0);assert.equal(paid.allocations.length,1)
    assert.equal(added[0].subject,paid.allocations[0].id)
    assert.ok(added[0].at>=raceStart&&added[0].at<=Date.now())
    const document = await (await h.raw(`/app/billing/${manual.result.run}.json`,{cookie:owner})).json()
    const events = document.invoices.find(r=>r.id===invoice).audit
    for (const action of ['invoice.manual','invoice.approve','invoice.issue']) {
      const expected = (await h.api('audit',owner)).find(r=>r.subject===invoice&&r.action===action)
      assert.deepEqual(events.find(r=>r.action===action),{at:expected.at,actor:expected.actor,action,detail:JSON.parse(expected.detail)})
    }
  }
  await auditImportWrites(h,owner)
  await h.api('access.give',owner,{email:'audit-accountant@example.test',name:'Audit Accountant',role:'accountant'})
  const accountant = await h.signIn('audit-accountant@example.test',{requested:true})
  const trail = await h.api('audit',owner)
  assert.deepEqual(await h.api('audit',accountant),trail,'accountant reads the identical complete trail')
  for (const who of [owner,accountant]) {
    const html=await h.page('/app/audit',who)
    for(const text of ['Audit trail','customer create','invoice issue','payment allocate','Synthetic audit adjustment'])assert.ok(html.includes(text),text)
  }
  assert.deepEqual(trail.filter(r=>original.some(old=>old.seq===r.seq)),original,'the initial trail remains byte-for-byte intact')
  console.log(`GOV-004 auditBillingWrites passed: ${coverage.size} distinct action and door pairs; two allocation races; accountant and invoice parity`)
}

try {
  await check('NEC-01 business, currency, timezone and declared tax', async () => {
    assert.equal((await h.raw('/auth/bootstrap', { body: { token: h.vars.SETUP_TOKEN, displayName: 'Rosa Owner' } })).status, 303)
    cookie.owner = await h.signIn(h.vars.OWNER_EMAIL)
    assert.equal((await h.raw('/setup', { cookie: cookie.owner, form: new URLSearchParams({ confirm: 'yes' }) })).status, 303)
    assert.equal((await h.raw('/api/nectar/me')).status, 401)
    assert.equal((await h.raw('/app', { cookie: cookie.owner })).headers.get('location'), `${h.origin}/app/settings`)
    await h.api('business.configure', cookie.owner, { legal_name: 'Riverbend Software Inc', timezone: 'Mars/Olympus', invoice_prefix: 'RB', payment_terms_days: 30 }, 400)
    await h.api('business.configure', cookie.owner, { legal_name: 'Riverbend Software Inc', timezone: 'America/Los_Angeles', invoice_prefix: 'RB', payment_terms_days: 30, currency: 'EUR' }, 400)
    const saved = await h.submit('business.configure', cookie.owner, { legal_name: 'Riverbend Software Inc', timezone: 'America/Los_Angeles', invoice_prefix: 'rb', payment_terms_days: '30', billing_email: 'billing@riverbend.example', address: '1 River Rd, Sacramento, CA' })
    assert.equal(saved.searchParams.get('notice'), 'Saved.')
    const business = await h.api('business', cookie.owner)
    assert.equal(business.currency, 'USD'); assert.equal(business.invoice_prefix, 'RB'); assert.equal(business.taxReady, false)
    await h.api('tax.declare', cookie.owner, { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '0', tax_note: 'x' }, 400)
    await applyPolicy(h, cookie.owner, 'tax.declare', { tax_jurisdiction: 'CA', tax_mode: 'flat_rate', tax_rate: '8.25', tax_note: 'Advised by our CPA, September 2026' })
    assert.equal((await h.api('business', cookie.owner)).tax_rate, '8.25')
    assert.match(await h.page('/app/settings', cookie.owner), /Not reviewed/)
  })

  if (process.argv.includes('--audit-only')) {
    await h.api('tax.review',cookie.owner,{revision:(await h.api('business',cookie.owner)).revision})
    await auditBillingWrites(h,cookie.owner)
    await h.close()
    await runIsolatedJourney('invoice-content.mjs','auditAutomatedPolicyWrites',async()=>({auditAutomatedPolicyWrites}))
    process.exit(0)
  }

  await catalogueSingleApproval(h, cookie.owner)

  await policyApprovals(h, cookie.owner)

  await check('NEC-02 customers and billing contacts with external ids', async () => {
    const created = await h.submit('customer.create', cookie.owner, { external_id: 'NW-1001', name: 'Northwind Robotics', billing_email: 'ap@northwind.example', address: '9 Dock St, Seattle, WA' }, '/app/customers/{id}')
    ids.northwind = created.pathname.split('/').pop()
    ids.pinecrest = (await h.api('customer.create', cookie.owner, { external_id: 'PC-2002', name: 'Pinecrest Labs', billing_email: 'billing@pinecrest.example', tax_exempt: true, tax_exempt_ref: 'CA-RESALE-88' })).id
    await h.api('customer.create', cookie.owner, { external_id: 'NW-1001', name: 'Copy', billing_email: 'x@example.test' }, 409)
    await h.api('customer.create', cookie.owner, { external_id: 'X-1', name: 'Bad', billing_email: 'not-an-email' }, 400)
    await h.api('customer.create', cookie.owner, { external_id: 'X-2', name: 'No ref', billing_email: 'x@example.test', tax_exempt: true }, 400)
    await h.api('contact.add', cookie.owner, { customer: ids.northwind, name: 'Ada Payables', email: 'ada@northwind.example', role: 'accounts payable' })
    await h.api('contact.add', cookie.owner, { customer: ids.northwind, name: 'Ada again', email: 'ada@northwind.example' }, 409)
    const view = await h.api(`customers/${ids.northwind}`, cookie.owner)
    assert.equal(view.external_id, 'NW-1001'); assert.equal(view.contacts.length, 1)
    assert.match(await h.page('/app/customers', cookie.owner), /Northwind Robotics/)
    const edit = { customer: ids.northwind, revision: view.revision, name: view.name, billing_email: view.billing_email, address: 'Updated billing address' }
    await h.api('customer.update', cookie.owner, edit)
    assert.equal((await h.api('customer.update', cookie.owner, { ...edit, address: 'Stale replacement' }, 409)).error, 'stale')
    assert.equal((await h.api(`customers/${ids.northwind}`, cookie.owner)).address, edit.address)
  })

  await check('NEC-03 products, immutable price versions and meters', async () => {
    ids.core = (await h.api('product.create', cookie.owner, { code: 'core', name: 'Core plan' })).id
    ids.seatsProduct = (await h.api('product.create', cookie.owner, { code: 'seats', name: 'Seats' })).id
    ids.eventsProduct = (await h.api('product.create', cookie.owner, { code: 'events', name: 'Event processing' })).id
    ids.meter = (await h.api('meter.create', cookie.owner, { code: 'events', name: 'Processed events', unit_label: 'events' })).id
    ids.coreV1 = (await h.api('price.create', cookie.owner, { product: ids.core, kind: 'flat', unit_amount: '499', nickname: 'Monthly' })).id
    ids.seat = (await h.api('price.create', cookie.owner, { product: ids.seatsProduct, kind: 'seat', unit_amount: '30.00' })).id
    await h.api('price.create', cookie.owner, { product: ids.eventsProduct, kind: 'unit', unit_amount: '0.0004' }, 400)
    await h.api('price.create', cookie.owner, { product: ids.eventsProduct, kind: 'unit', unit_amount: '0.0000001', meter: 'events' }, 400)
    ids.events = (await h.api('price.create', cookie.owner, { product: ids.eventsProduct, kind: 'unit', unit_amount: '0.0004', meter: 'events' })).id
    const second = await publishPrice(h, cookie.owner, { product: ids.seatsProduct, kind: 'seat', unit_amount: '35' })
    assert.equal(second.version, 2)
    const catalog = await h.api('catalog', cookie.owner)
    const v1 = catalog.prices.find(price => price.id === ids.seat)
    assert.equal(v1.unit_amount, '30.00'); assert.equal(v1.version, 1)
    assert.equal(catalog.prices.find(price => price.id === ids.events).unit_amount, '0.0004')
    await h.api('price.retire', cookie.owner, { price: second.id })
    assert.equal((await h.api('subscription.create', cookie.owner, { customer: ids.pinecrest, start_date: '2026-07-01', price: [second.id], quantity: ['1'] }, 404)).error, 'price_not_found')
    await h.api('feature.grant', cookie.owner, { product: ids.eventsProduct, feature: 'api_access' })
  })

  await check('NEC-04 subscriptions with anchor, trial and approved exceptions', async () => {
    const created = await h.submit('subscription.create', cookie.owner, { customer: ids.northwind, start_date: '2026-07-01', anchor_day: '1', price: [ids.coreV1, ids.seat, ids.events], quantity: ['', '5', ''],
      exception_kind: 'discount_percent', exception_value: '10', exception_effective_from: '2026-07-01', exception_note: 'Launch partner', exception_clause: '§4.2 Customer receives a ten percent (10%) discount on platform and seat fees for the term.' }, '/app/subscriptions/{id}')
    ids.s1 = created.pathname.split('/').pop()
    ids.s2 = (await h.api('subscription.create', cookie.owner, { customer: ids.pinecrest, start_date: '2026-07-15', trial_end: '2026-07-29', price: [ids.coreV1], quantity: [''] })).id
    await h.api('subscription.create', cookie.owner, { customer: ids.northwind, start_date: '2026-07-01', price: [ids.events], quantity: [''] }, 409)
    await h.api('subscription.create', cookie.owner, { customer: ids.pinecrest, start_date: '2026-07-31', price: [ids.coreV1] }, 400)
    const s1 = await h.api(`subscriptions/${ids.s1}`, cookie.owner)
    assert.equal(s1.anchor_day, 1); assert.equal(s1.items.length, 3)
    assert.equal(s1.amendments[0].status, 'proposed')
    ids.discount = s1.amendments[0].id
    // A proposed exception does not bill; it bills from the moment a person approves it.
    await h.api('amendment.decide', cookie.owner, { amendment: ids.discount, decision: 'approved' })
    await h.api('amendment.decide', cookie.owner, { amendment: ids.discount, decision: 'approved' }, 409)
    assert.equal((await h.api(`subscriptions/${ids.s1}`, cookie.owner)).amendments[0].status, 'approved')
  })

  await check('NEC-05 usage with stable ids and duplicate rejection', async () => {
    const rows = [
      ['e-001', 'NW-1001', 'events', '1000000', '2026-07-02T10:00:00-07:00'],
      ['e-002', 'NW-1001', 'events', '2345678.5', '2026-07-15T12:00:00-07:00'],
      ['e-003', 'NW-1001', 'events', '1000', '2026-07-31T23:30:00-07:00'],
      ['e-004', 'NW-1001', 'events', '500', '2026-08-01T00:30:00-07:00'],
      ['e-001', 'NW-1001', 'events', '1000000', '2026-07-02T17:00:00Z'],
      ['e-002', 'NW-1001', 'events', '9', '2026-07-15T12:00:00-07:00'],
      ['e-005', 'ZZ-9', 'events', '1', '2026-07-03T10:00:00-07:00'],
      ['e-006', 'NW-1001', 'events', '1', '2026-07-03 10:00'],
      ['e-007', 'PC-2002', 'events', '10', '2026-07-20T10:00:00-07:00'],
    ]
    const form = new FormData(); form.set('returnTo', '/app/usage'); form.set('file', new Blob([csv(rows)], { type: 'text/csv' }), 'july.csv')
    const response = await h.raw('/app/do/usage.submit', { cookie: cookie.owner, form })
    assert.equal(response.status, 303)
    const batch = (await h.api('usage/batches', cookie.owner))[0]
    assert.deepEqual([batch.accepted, batch.duplicates, batch.rejected], [5, 1, 3])
    const report = JSON.parse(batch.report_json)
    assert.ok(report.some(row => row.eventId === 'e-002' && /different values/.test(row.reason)))
    // The same file again adds nothing.
    const again = await h.api('usage.submit', cookie.owner, { file: file('july.csv', csv(rows), 'text/csv') })
    assert.deepEqual([again.accepted, again.duplicates], [0, 6])
  })

  await check('NEC-06 missing and late usage and exact totals before rating', async () => {
    const view = await h.api('usage/inspect?period=2026-07', cookie.owner)
    const s1 = view.subscriptions.find(sub => sub.subscription === ids.s1)
    const meter = s1.meters[0]
    // 23:30 on 31 July in Los Angeles is 1 August in UTC: it belongs to July; 00:30 on 1 August does not.
    assert.equal(meter.total, '3346678.50'); assert.equal(meter.events, 3)
    assert.equal(s1.boundaries.to, '2026-08-01T07:00:00.000Z')
    assert.equal(meter.daysWithoutUsage.length, 28)
    assert.ok(view.unattributed.some(event => event.event_id === 'e-007'), 'usage no price rates is listed')
    assert.match(await h.page('/app/usage?period=2026-07', cookie.owner), /3,346,678\.5 events/)
  })

  await check('NEC-07 deterministic rating with explicit rounding', async () => {
    await h.api('invoice.finalise', cookie.owner, { run: 'none' }, 409)
    const run = await h.api('billrun.prepare', cookie.owner, { period: '2026-07' })
    ids.julyRun = run.id
    const draft = await h.api(`invoices/${(await invoiceOf(run.id, 'Northwind Robotics')).id}`, cookie.owner)
    const amounts = Object.fromEntries(draft.lines.map(line => [line.kind + (line.kind === 'discount' ? '' : `:${line.description.split(' ')[0]}`), line.amount_cents]))
    assert.equal(amounts['flat:Core'], 49900); assert.equal(amounts['seat:Seats'], 15000)
    assert.equal(amounts.discount, -6490)
    // 3,346,678.5 events × $0.0004 = $1,338.6714 → $1,338.67, rounded once on the summed quantity.
    assert.equal(amounts['usage:Event'], 133867)
    assert.equal(draft.subtotal_cents, 192277)
    assert.equal(draft.tax_cents, 15863)
    assert.equal(draft.total_cents, 208140)
    // Trial days are not charged; the rest of the period is prorated by days: $499 × 17 / 31 = $273.645… → $273.65.
    const pinecrest = await h.api(`invoices/${(await invoiceOf(run.id, 'Pinecrest Labs')).id}`, cookie.owner)
    assert.equal(pinecrest.lines.find(line => line.kind === 'flat').amount_cents, 27365)
    assert.equal(pinecrest.tax_cents, 0, 'exempt customer')
    // Preparing again from the same inputs gives the same calculation.
    const again = await h.api('billrun.prepare', cookie.owner, { period: '2026-07' })
    ids.julyRun = again.id
    const redraft = await h.api(`invoices/${(await invoiceOf(again.id, 'Northwind Robotics')).id}`, cookie.owner)
    assert.equal(redraft.source_fingerprint, draft.source_fingerprint)
    assert.deepEqual(redraft.lines.map(line => [line.kind, line.amount_cents]), draft.lines.map(line => [line.kind, line.amount_cents]))
  })

  await check('NEC-10 approval, source changes and numbered finalisation', async () => {
    // Finalising waits for the owner's tax review.
    await h.api('invoice.approve', cookie.owner, { run: ids.julyRun })
    await h.api('invoice.finalise', cookie.owner, { run: ids.julyRun }, 409)
    await h.api('tax.review', cookie.owner, { revision: (await h.api('business', cookie.owner)).revision })
    // A late usage event changes Northwind's July inputs: its approval no longer holds.
    await usage(cookie.owner, [['e-008', 'NW-1001', 'events', '100', '2026-07-20T09:00:00-07:00']])
    await h.api('invoice.finalise', cookie.owner, { run: ids.julyRun, issue_date: '2026-08-01' }, 400)
    const partial = await h.api('invoice.finalise', cookie.owner, { run: ids.julyRun, issue_date: '2026-08-15' })
    assert.deepEqual(partial.issued, ['RB-000001'])
    assert.equal(partial.refused.length, 1); assert.equal(partial.refused[0].reason, 'source_changed')
    const run = await h.api('billrun.prepare', cookie.owner, { period: '2026-07' })
    assert.equal(run.summary.skipped.length, 1, 'the issued period is never drafted again')
    const draft = await h.api(`invoices/${(await invoiceOf(run.id, 'Northwind Robotics')).id}`, cookie.owner)
    assert.equal(draft.lines.find(line => line.kind === 'usage').amount_cents, 133871)
    const credit = { subscription: ids.s1, kind: 'fixed_credit', value: '50', effective_from: '2026-07-10', note: 'Goodwill' }
    const lateCredit = await h.api('amendment.propose', cookie.owner, credit)
    await h.api('invoice.approve', cookie.owner, { invoice: draft.id })
    await h.api('invoice.finalise', cookie.owner, { invoice: draft.id, issue_date: '2026-07-31' }, 400)
    const issued = await h.api('invoice.finalise', cookie.owner, { invoice: draft.id, issue_date: '2026-08-01' })
    assert.deepEqual(issued.issued, ['RB-000002'])
    ids.julyNorthwind = draft.id
    assert.equal((await h.api('business.configure', cookie.owner, { revision: (await h.api('business', cookie.owner)).revision, legal_name: 'Riverbend Software Inc', timezone: 'UTC', invoice_prefix: 'RB', payment_terms_days: 30 }, 409)).error, 'timezone_fixed_after_first_invoice')
    assert.equal((await h.api('business', cookie.owner)).timezone, 'America/Los_Angeles')
    const invoice = await h.api(`invoices/${draft.id}`, cookie.owner)
    assert.equal(invoice.status, 'issued'); assert.equal(invoice.due_date, '2026-08-31'); assert.equal(invoice.total_cents, 208144)
    assert.equal(invoice.approved_fingerprint, invoice.source_fingerprint)
    // Issued totals never change: approving or re-finalising it is refused, and the period is not drafted again.
    await h.api('invoice.approve', cookie.owner, { invoice: draft.id }, 409)
    // An exception starting inside the issued period could never bill, so it is refused, not silently lost.
    assert.equal((await h.api('amendment.decide', cookie.owner, { amendment: lateCredit.amendment, decision: 'approved' }, 409)).error, 'period_already_invoiced')
    await h.api('amendment.propose', cookie.owner, credit, 409)
    await h.api('amendment.decide', cookie.owner, { amendment: lateCredit.amendment, decision: 'rejected' })
    const third = await h.api('billrun.prepare', cookie.owner, { period: '2026-07' })
    assert.equal(third.summary.invoices, 0); assert.equal(third.summary.skipped.length, 2)
  })

  await check('NEC-08 scheduled changes bill exactly as previewed', async () => {
    const s1 = await h.api(`subscriptions/${ids.s1}`, cookie.owner)
    const seats = s1.items.find(item => item.kind === 'seat')
    await h.api('change.prepare', cookie.owner, { subscription: ids.s1, item: seats.id, quantity: 8, effective_date: '2026-07-20' }, 409)
    const prepared = await h.api('change.prepare', cookie.owner, { subscription: ids.s1, item: seats.id, quantity: 8, effective_date: '2026-08-16' })
    ids.change = prepared.change
    assert.equal(prepared.preview.before.cents, 49900 + 15000 - 6490)
    assert.deepEqual(prepared.preview.after.lines.map(line => line.amountCents).sort((a, b) => a - b), [-6955, 7258, 12387, 49900])
    const stale = await h.api('change.prepare', cookie.owner, { subscription: ids.s1, item: seats.id, quantity: 6, effective_date: '2026-08-20' })
    // Nothing bills from a prepared change until a person approves it; an agent cannot.
    await h.api('change.decide', cookie.owner, { change: ids.change, decision: 'approved' })
    await h.api('change.decide', cookie.owner, { change: stale.change, decision: 'approved' }, 409)
    const run = await h.api('billrun.prepare', cookie.owner, { period: '2026-08' })
    ids.augustRun = run.id
    const draft = await h.api(`invoices/${(await invoiceOf(run.id, 'Northwind Robotics')).id}`, cookie.owner)
    assert.deepEqual(recurring(draft.lines), prepared.preview.after.lines.map(({ description, amountCents, periodStart, periodEnd }) => ({ description, amountCents, periodStart, periodEnd })))
  })

  await check('NEC-09 draft bill run comparison and exceptions', async () => {
    // A late event for issued July is replayed at July's saved price/tax,
    // then its exact governed delta bills on the August statement.
    await usage(cookie.owner, [['e-009', 'NW-1001', 'events', '2500', '2026-07-25T08:00:00-07:00']])
    const correction=await h.api('usage.correction.prepare',cookie.owner,{subscription:ids.s1,from_period:'2026-07',through_period:'2026-07',void_event_ids:[],add_event_ids:['e-009'],reason:'Late July source event',explanation:'July source usage arrived after issue. The exact saved-price difference will appear on August.'})
    await h.api('usage.correction.decide',cookie.owner,{correction:correction.id,decision:'approved'})
    const run = await h.api('billrun.prepare', cookie.owner, { period: '2026-08' })
    ids.augustRun = run.id
    const detail = await h.api(`runs/${run.id}`, cookie.owner)
    assert.equal(detail.summary.previous.period, '2026-07')
    const northwind = detail.invoices.find(invoice => invoice.customer_name === 'Northwind Robotics')
    assert.deepEqual(northwind.exceptions.map(e => e.code), ['large_change'])
    assert.equal(northwind.comparison.previous.number, 'RB-000002')
    const invoice = await h.api(`invoices/${northwind.id}`, cookie.owner)
    const late = invoice.lines.find(line => line.kind === 'usage_correction')
    assert.equal(late.amount_cents, 100); assert.equal(late.period_start, '2026-07-01')
    assert.deepEqual([...late.evidence.eventIds].sort(), ['e-001','e-002','e-003','e-008','e-009'])
    assert.equal(late.evidence.originalInvoice,ids.julyNorthwind)
    assert.equal(invoice.lines.find(line => line.kind === 'usage').amount_cents, 20)
    const page = await h.page(`/app/billing/${run.id}`, cookie.owner)
    assert.match(page, /Large change/); assert.match(page, /Draft invoices \(2\)/)
    // Exceptions must be acknowledged by the person approving.
    await h.api('invoice.approve', cookie.owner, { invoice: northwind.id }, 409)
  })

  await check('NEC-11 credit notes, payment evidence and allocations', async () => {
    const id = ids.julyNorthwind
    await h.api('credit.issue', cookie.owner, { invoice: id, amount: '5000.00', reason: 'too much' }, 409)
    const credit = await h.api('credit.issue', cookie.owner, { invoice: id, amount: '500.00', reason: 'Service credit for the 12 July outage' })
    assert.equal(credit.number, 'RB-CN-000001')
    await h.api('payment.record', cookie.owner, { customer: ids.northwind, amount: '1000.001', received_on: '2026-08-20', method: 'bank_transfer', reference: 'WIRE-7781' }, 400)
    const paid = await h.api('payment.record', cookie.owner, { customer: ids.northwind, amount: '1000.00', received_on: '2026-08-20', method: 'bank_transfer', reference: 'WIRE-7781', evidence: 'Bank statement line 2026-08-20' })
    await h.api('payment.record', cookie.owner, { customer: ids.northwind, amount: '1000.00', received_on: '2026-08-21', method: 'bank_transfer', reference: 'WIRE-7781' }, 409)
    await h.api('payment.allocate', cookie.owner, { payment: paid.payment, invoice: id, amount: '1500.00' }, 409)
    await h.api('payment.allocate', cookie.owner, { payment: paid.payment, invoice: id, amount: '1000.00' })
    const invoice = await h.api(`invoices/${id}`, cookie.owner)
    assert.equal(invoice.total_cents, 208144)
    assert.equal(invoice.creditedCents + invoice.paidCents + invoice.balanceCents, invoice.total_cents)
    assert.equal(invoice.balanceCents, 58144)
    const ledger = (await h.api(`customers/${ids.northwind}`, cookie.owner)).ledger
    assert.deepEqual([ledger.invoicedCents, ledger.creditedCents, ledger.paidCents, ledger.balanceCents, ledger.unallocatedCents], [208144, 50000, 100000, 58144, 0])
  })

  await check('NEC-12 ageing, reminder drafts and follow-up tasks', async () => {
    const age = await h.api('ageing', cookie.owner)
    const row = age.invoices.find(invoice => invoice.id === ids.julyNorthwind)
    assert.ok(row.daysOverdue > 0 && row.bucket !== 'current')
    const draft = await h.api('reminder.prepare', cookie.owner, { customer: ids.northwind })
    const second = await h.api('payment.record', cookie.owner, { customer: ids.northwind, amount: '100.00', received_on: '2026-09-02', method: 'check', reference: 'CHK-1044' })
    await h.api('payment.allocate', cookie.owner, { payment: second.payment, invoice: ids.julyNorthwind, amount: '100.00' })
    await h.api('reminder.approve', cookie.owner, { notice: draft.id, recipient: 'ap@northwind.example', subject: 'x', body: 'y' }, 409)
    const fresh = await h.api('reminder.prepare', cookie.owner, { customer: ids.northwind })
    const notices = await h.api('notices', cookie.owner)
    const text = notices.find(notice => notice.id === fresh.id)
    assert.match(text.body, /\$481\.44 outstanding/)
    await h.api('reminder.approve', cookie.owner, { notice: fresh.id, recipient: 'ada@northwind.example', subject: 'Reminder: invoice RB-000002', body: text.body })
    const exported = await h.raw(`/app/notices/${fresh.id}.txt`, { cookie: cookie.owner })
    assert.equal(exported.status, 200)
    assert.match(await exported.text(), /^To: ada@northwind\.example\nSubject: Reminder: invoice RB-000002/)
    assert.equal((await h.api('notices', cookie.owner)).find(notice => notice.id === fresh.id).status, 'exported')
    const tasks = await h.api('tasks', cookie.owner)
    const task = tasks.find(t => t.status === 'open' && /ada@northwind/.test(t.title))
    await h.api('task.complete', cookie.owner, { task: task.id, outcome: 'Ada confirmed payment run on Friday' })
    assert.match(await h.page('/app/receivables', cookie.owner), /Ada confirmed payment run/)
  })

  await check('NEC-14 agent prepares, a person approves', async () => {
    const issued = await h.raw('/app/access/credential', { cookie: cookie.owner, form: new URLSearchParams([['name', 'Finance agent'], ['scopes', 'prepare']]) })
    const html = await issued.text()
    ids.agentKey = html.match(/nectar_[A-Za-z0-9_-]{30,}/)[0]
    const agent = { bearer: ids.agentKey }
    ids.meterKey = (await h.api('credential.issue', cookie.owner, { name: 'Metering pipeline', scopes: ['usage'] })).key
    assert.equal((await h.api('customers', agent)).length, 2)
    await h.api('customer.create', agent, { external_id: 'AG-1', name: 'Agent made', billing_email: 'a@example.test' }, 403)
    await h.api('usage.submit', agent, { events: [] }, 403)
    await h.api('customers', { bearer: ids.meterKey }, undefined, 403)
    assert.equal((await usage({ bearer: ids.meterKey }, [['m-001', 'NW-1001', 'events', '40', '2026-08-03T09:00:00-07:00']])).accepted, 1)
    // Contract to terms: quoted clauses are required; Nectar computes the effect itself.
    const terms = { subscription: ids.s2, kind: 'discount_percent', value: '20', effective_from: '2026-09-15', note: 'Renewal discount' }
    await h.api('proposal.create', agent, { kind: 'amendment', title: 'Renewal discount', payload: terms, evidence: { clauses: [] } }, 400)
    const proposal = await h.api('proposal.create', agent, { kind: 'amendment', title: 'Pinecrest renewal: 20% discount', payload: terms, evidence: { clauses: [{ quote: 'From 15 September 2026 the subscription fee is reduced by twenty percent (20%).', reference: 'Renewal order form, §2' }], ambiguities: ['The order form does not say whether the discount ends; proposed with no end date.'] } })
    assert.equal(proposal.impact[0].before.subtotalCents, 49900); assert.equal(proposal.impact[0].after.subtotalCents, 39920)
    await h.api('proposal.decide', agent, { proposal: proposal.id, decision: 'approved' }, 403)
    await h.api('proposal.create', agent, { kind: 'amendment', title: 'July goodwill credit', payload: { subscription: ids.s1, kind: 'fixed_credit', value: '50', effective_from: '2026-07-10' }, evidence: { clauses: [{ quote: 'A one-time $50 credit applies from 10 July 2026.' }] } }, 409)
    const stale = await h.api('proposal.create', agent, { kind: 'amendment', title: 'Second terms', payload: { ...terms, value: '5' }, evidence: { clauses: [{ quote: 'five percent' }] } })
    await h.api('proposal.decide', cookie.owner, { proposal: proposal.id, decision: 'approved', note: 'Matches the signed renewal' })
    assert.equal((await h.api(`proposals/${stale.id}`, cookie.owner)).stale, true)
    await h.api('proposal.decide', cookie.owner, { proposal: stale.id, decision: 'approved' }, 409)
    await h.api('proposal.decide', cookie.owner, { proposal: stale.id, decision: 'rejected' })
    const s2 = await h.api(`subscriptions/${ids.s2}`, cookie.owner)
    assert.equal(s2.amendments.find(a => a.origin === 'proposal').status, 'approved')
    // Pricing change with evidence: selected subscriptions, exact effective date, computed impact.
    const change = await h.api('proposal.create', agent, { kind: 'price_change', title: 'Core plan to $549 from October', payload: { product: ids.core, kind: 'flat', unit_amount: '549', nickname: 'Monthly 2027', effective_date: '2026-10-01', subscriptions: [ids.s1] }, evidence: { reason: 'Annual price review' } })
    assert.equal(change.impact[0].periods[0].after.subtotalCents - change.impact[0].periods[0].before.subtotalCents, 4500)
    await h.api('proposal.decide', cookie.owner, { proposal: change.id, decision: 'approved' })
    assert.ok((await h.api('catalog', cookie.owner)).prices.some(price => price.product_id === ids.core && price.version === 2 && price.unit_amount === '549.00'))
    // Bill-run exception: void a duplicated event with sources; approval re-prepares the draft, approves no invoice.
    await h.api('proposal.create', agent, { kind: 'usage_correction', title: 'Void retry duplicate', payload: { void: [{ event_id: 'e-004', reason: 'Retry duplicate' }], run: ids.augustRun }, evidence: {} }, 400)
    // An addition that the usage import would reject is refused when proposed, never dropped after approval.
    const missed = { event_id: 'c-001', customer: 'NW-1001', meter: 'events', quantity: '100', occurred_at: '2026-08-05T09:00:00-07:00' }
    assert.equal((await h.api('proposal.create', agent, { kind: 'usage_correction', title: 'Add missed events', payload: { add: [missed, { ...missed, event_id: 'c-002', customer: 'NOPE' }] }, evidence: { sources: ['Gateway log'] } }, 400)).error, 'correction_rows_rejected')
    const correction = await h.api('proposal.create', agent, { kind: 'usage_correction', title: 'Void retry duplicate e-004', payload: { void: [{ event_id: 'e-004', reason: 'Retry of m-001' }], add: [missed], run: ids.augustRun }, evidence: { sources: ['Gateway log 2026-08-01 00:30 PDT shows a retry'] } })
    // Nectar rates the effect itself: August usage 540 events ($0.22) becomes 140 ($0.06).
    const effect = correction.impact.invoices.find(invoice => invoice.customer === 'Northwind Robotics')
    assert.equal(effect.after.subtotalCents - effect.before.subtotalCents, -16)
    const done = await h.api('proposal.decide', cookie.owner, { proposal: correction.id, decision: 'approved' })
    assert.deepEqual([done.voided, done.added], [1, 1])
    assert.equal((await h.api(`proposals/${correction.id}`, cookie.owner)).result.added, 1)
    ids.augustRun = done.rerun
    const redraft = await h.api(`runs/${done.rerun}`, cookie.owner)
    assert.ok(redraft.invoices.every(invoice => invoice.status === 'draft'))
    const northwind = await h.api(`invoices/${redraft.invoices.find(i => i.customer_name === 'Northwind Robotics').id}`, cookie.owner)
    assert.equal(northwind.lines.find(line => line.kind === 'usage').evidence.eventIds.join(), 'm-001,c-001')
    // Collections preparation: the person approves the recipient and wording.
    const collection = await h.api('proposal.create', agent, { kind: 'collection', title: 'Remind Northwind', payload: { customer: ids.northwind } })
    const approved = await h.api('proposal.decide', cookie.owner, { proposal: collection.id, decision: 'approved', recipient: 'ap@northwind.example' })
    assert.equal((await h.api('notices', cookie.owner)).find(n => n.id === approved.notice).status, 'approved')
    await h.api('credential.revoke', cookie.owner, { key: (await h.api('credentials', cookie.owner)).find(k => k.name === 'Finance agent').id })
    await h.api('customers', agent, undefined, 401)
  })

  await check('NEC-15 roles are enforced in every handler', async () => {
    await h.api('access.give', cookie.owner, { email: 'fran@example.test', name: 'Fran Finance', role: 'finance' })
    await h.api('access.give', cookie.owner, { email: 'acct@example.test', name: 'Avery Accountant', role: 'accountant' })
    await h.api('access.give', cookie.owner, { email: 'x@example.test', name: 'Nope', role: 'owner' }, 400)
    cookie.finance = await h.signIn('fran@example.test', { requested: true })
    cookie.accountant = await h.signIn('acct@example.test', { requested: true })
    const ownerOnly = ['processor.cash.imported.prepare','processor.cash.imported.confirm','processor.cash.return.preview','processor.cash.return.prepare','dunning.withdraw','dunning.policy.create','dunning.enroll','dunning.mail.prepare','dunning.mail.send','dunning.end','retry.segment.assign','retry.method.prepare','retry.churn.record','retry.policy.configure','payment_link.activate','payment_link.create','payment_link.deactivate','automatic.collection.prepare','automatic.collection.revoke','automatic.collection.reconcile','automatic.collection.event','collection.customer.bind','collection.prepare','collection.confirm','collection.reconcile','prepaid.topup.prepare','prepaid.topup.revoke','prepaid.topup.run','prepaid.topup.reconcile','prepaid.prepare','prepaid.purchase.prepare','prepaid.funding.confirm','prepaid.consent.revoke','prepaid.settle','imported.collection.prepare','imported.collection.execute','imported.collection.reconcile','imported.collection.finalize','mfa.policy', 'mfa.reset', 'cadence.policy.prepare', 'lifecycle.policy', 'credit.policy', 'certificate.policy', 'business.configure', 'invoice.series','entity.create','entity.update','customer.entity','invoice.series.capture','invoice.series.capture-live', 'tax.declare', 'tax.review', 'access.give', 'access.end', 'credential.issue', 'credential.revoke', 'subscription.adopt']
    const metricPreview = await h.api('meter.prepare', cookie.owner, { code:'role-preview', name:'Role preview', unit_label:'events', source_meter:ids.meter, definition:{ aggregation:'count' } })
    assert.ok(ACTIONS.length > 30)
    for (const name of ACTIONS) {
      if (name === 'usage.correction.preview' || name === 'invoice.refund.preview') {
        await h.api(name,cookie.accountant,{},400)
      } else if (name === 'answer.read') {
        const answer = await h.api(name,cookie.accountant,{customer:ids.northwind,invoice:ids.julyNorthwind,question:'What is the invoice total?'})
        assert.equal(answer.invoiceId,ids.julyNorthwind,'AGENT-007 accountant reads cited invoice answers')
      } else if (name === 'report.schedule') {
        await h.api(name,cookie.accountant,{enabled:false,day:1})
        assert.equal((await h.api('report-schedule',cookie.accountant)).schedule.enabled,false,'RPT-002 accountant controls their own report schedule')
      } else if (name.startsWith('mfa.') && !ownerOnly.includes(name)) {
        const own = await h.raw(`/api/nectar/${name}`, { cookie: cookie.accountant, body: {} })
        assert.ok([200, 400, 404, 409].includes(own.status), `GOV-007 every role manages its own factor: ${name} ${own.status}`)
      } else if (name === 'notification.preferences') await h.api(name,cookie.accountant,{ mentions:true,payment_mismatch:false,billrun_exceptions:false,proposals:false })
      else if (name === 'meter.preview') {
        const preview = await h.api(name, cookie.accountant, { request:metricPreview.request, customer:ids.northwind, period:'2020-01' })
        assert.deepEqual(preview.results.map(row => row.exact), [{ numerator:'0', denominator:'1' }], 'USE-002 accountant can preview actual historical inputs')
      } else await h.api(name, cookie.accountant, {}, 403)
      await h.api(name, undefined, {}, 401)
      if (ownerOnly.includes(name)) await h.api(name, cookie.finance, {}, 403)
      else if (name === 'prepaid.refund.prepare') {
        // CAT-012 permits finance preparation; real funded preparation and
        // independent approval are exercised by prepaidRefundFlow.
        const refused = await h.api(name, cookie.finance, { grant: 'synthetic-nectar-602', reason: 'Synthetic unfunded refund request' }, 409)
        assert.equal(refused.error, 'prepaid_refund_paid_card_required', 'Finance must still supply a funded refundable grant')
      }
    }
    for (const [pattern] of API_DOORS) {
      const path = pattern.replace(/^\^|\$$/g, '').replace(/\(\[[^)]*\]\+\)/g, 'none')
      const response = await h.raw(`/api/nectar/${path}`)
      assert.equal(response.status, 401, path)
      const accountant = await h.raw(`/api/nectar/${path}`, { cookie: cookie.accountant })
      assert.ok([200, 400, 403, 404].includes(accountant.status), `${path}: ${accountant.status}`)
      if (['members', 'credentials', 'imports','billing-entities'].includes(path)) assert.equal(accountant.status, 403, path)
    }
    for (const [pattern,name] of PAGE_DOORS) {
      const path = name==='importOriginals'?'/app/import/none/originals/'+'0'.repeat(64):pattern.replace(/^\^|\$$/g, '').replace(/\(\[[^)]*\]\+\)/g, 'none').replace(/\\\./g, '.')
      const response = await h.raw(path)
      assert.equal(response.status, 303, path)
      assert.match(response.headers.get('location'), /\/signin/)
    }
    // An accountant reads and exports; a finance operator works; neither manages access.
    assert.equal((await h.raw('/app/exports/invoices.csv', { cookie: cookie.accountant })).status, 200)
    assert.equal((await h.raw('/app/access', { cookie: cookie.finance })).status, 403)
    await h.api('payment.record', cookie.finance, { customer: ids.pinecrest, amount: '50.00', received_on: '2026-09-01', method: 'check', reference: 'CHK-2001' })
    // Cross-site form posts are refused even with a session.
    assert.equal((await h.raw('/app/do/customer.create', { cookie: cookie.finance, form: new URLSearchParams({ external_id: 'X', name: 'X', billing_email: 'x@example.test' }), headers: { origin: 'https://evil.example' } })).status, 403)
    const accountantMember = (await h.api('members', cookie.owner)).find(m => m.email === 'acct@example.test')
    await h.api('access.end', cookie.owner, { member: accountantMember.id })
    await h.api('me', cookie.accountant, undefined, 401)
  })

  await check('NEC-13 exports and entitlement explanations', async () => {
    const invoices = await (await h.raw('/app/exports/invoices.csv', { cookie: cookie.owner })).text()
    const julyRow = invoices.split('\r\n').find(line => line.startsWith('RB-000002'))
    assert.ok(julyRow.includes(',2081.44,500.00,1100.00,481.44,'), julyRow)
    const usageCsv = await (await h.raw('/app/exports/usage.csv', { cookie: cookie.owner })).text()
    assert.match(usageCsv, /e-001,NW-1001,events,1000000\.00,2026-07-02T10:00:00-07:00,[^,]+,active,,RB-000002/)
    assert.match(usageCsv, /e-004,NW-1001,events,500\.00,.*voided,Retry of m-001/)
    assert.match(await (await h.raw('/app/exports/subscriptions.csv', { cookie: cookie.owner })).text(), /NW-1001,1,2026-07-01/)
    const july = (await h.api('runs', cookie.owner)).filter(run => run.period === '2026-07' && run.status === 'finalised')
    assert.equal(july.length, 2)
    const documents = await Promise.all(july.map(async run => await (await h.raw(`/app/billing/${run.id}.json`, { cookie: cookie.owner })).json()))
    const issued = documents.flatMap(document => document.invoices).find(invoice => invoice.number === 'RB-000002')
    assert.equal(issued.calculation.inputs.events.length, 4); assert.equal(issued.approval.fingerprint, issued.calculation.fingerprint)
    assert.ok(issued.audit.some(event => event.action === 'invoice.issue'))
    const allowed = await h.api('entitlements/NW-1001?feature=api_access&date=2026-09-10', cookie.owner)
    assert.equal(allowed.allowed, true); assert.ok(allowed.paths[0].steps.some(step => /grants "api_access"/.test(step)))
    const denied = await h.api('entitlements/PC-2002?feature=api_access&date=2026-09-10', cookie.owner)
    assert.equal(denied.allowed, false); assert.ok(denied.paths[0].steps.some(step => /does not grant/.test(step)))
    const before = await h.api('entitlements/NW-1001?feature=api_access&date=2026-06-15', cookie.owner)
    assert.equal(before.allowed, false); assert.match(before.paths[0].steps[0], /starts 2026-07-01/)
  })

  await auditBillingWrites(h,cookie.owner)

  await check('NEC-16 Stripe Billing move-in with dry run, journal, undo and shadow cutover', async () => {
    const files = await stripeFiles()
    const short = { ...files, manifest: file('manifest.json', JSON.stringify({ ...JSON.parse(await readFile(new URL('../fixtures/stripe/manifest.json', import.meta.url))), files: { customers: { count: 99, has_more: false } } })) }
    const refused = await h.api('import.preview', cookie.owner, short, 400)
    assert.equal(refused.error, 'capture_incomplete')
    const customersBefore = (await h.api('customers', cookie.owner)).length
    const preview = await h.api('import.preview', cookie.finance, files)
    assert.deepEqual(preview.create, { meter: 1, product: 4, price: 3, customer: 3, subscription: 2, invoice: 3 })
    for (const pattern of [/tiered pricing/, /every 1 year/, /status "incomplete"/, /draft invoices/]) assert.ok(preview.rejected.some(r => pattern.test(r.reason)), String(pattern))
    assert.equal((await h.api('customers', cookie.owner)).length, customersBefore, 'the preview writes nothing')
    await h.api('import.apply', cookie.owner, { ...files, fingerprint: '0'.repeat(64) }, 409)
    const applied = await h.api('import.apply', cookie.finance, { ...files, fingerprint: preview.fingerprint })
    assert.equal(applied.state, 'completed')
    assert.equal((await h.api('customers', cookie.owner)).length, customersBefore + 3)
    const repeat = await h.api('import.apply', cookie.finance, { ...files, fingerprint: preview.fingerprint })
    assert.equal(repeat.job, applied.job, 're-import adds nothing')
    // Undo an untouched move, then move in again as a new job.
    await h.api('import.job', cookie.finance, { job: applied.job, action: 'undo' })
    assert.equal((await h.api('customers', cookie.owner)).length, customersBefore)
    const again = await h.api('import.apply', cookie.finance, { ...files, fingerprint: preview.fingerprint })
    assert.notEqual(again.job, applied.job)
    // GOV-002: a prepared native revision retains its imported product/meter;
    // undo reports the dependency instead of orphaning the saved exact terms.
    const importedPrice = (await h.api('catalog', cookie.owner)).prices.find(p => p.origin === 'import')
    const pendingRevision = await h.api('price.create', cookie.owner, { product: importedPrice.product_id, kind: 'flat', unit_amount: '600' })
    assert.equal(pendingRevision.status, 'pending')
    const protectedMove = await h.api('import.job', cookie.owner, { job: again.job, action: 'undo' }, 409)
    assert.equal(protectedMove.error, 'undo_blocked')
    console.log('GOV-002 prepared catalogue revision protects move-in history from undo passed')
    const atlas = (await h.api('customers', cookie.owner)).find(c => c.external_id === 'cus_NcAtlasFreight01')
    const atlasView = await h.api(`customers/${atlas.id}`, cookie.owner)
    assert.equal(atlasView.subscriptions[0].billing_mode, 'shadow')
    assert.equal(atlasView.incumbentInvoices.length, 2)
    // Shadow: August is rated and compared with Stripe, never issued.
    const august = await h.api('billrun.prepare', cookie.owner, { period: '2026-08' })
    ids.augustRun = august.id
    let detail = await h.api(`runs/${august.id}`, cookie.owner)
    const atlasShadow = detail.invoices.find(i => i.customer_name === 'Atlas Freight Inc')
    assert.equal(atlasShadow.status, 'shadow'); assert.equal(atlasShadow.comparison.incumbent.reconciled, true)
    const harborShadow = detail.invoices.find(i => i.customer_name === 'Harbor Analytics LLC')
    assert.equal(harborShadow.comparison.incumbent.reconciled, false)
    await h.api('invoice.approve', cookie.owner, { invoice: atlasShadow.id }, 409)
    await usage(cookie.owner, [['hb-0820', 'cus_NcHarborAnalytics02', 'api_calls', '1250000', '2026-08-20T12:00:00-07:00']])
    detail = await h.api(`runs/${(await h.api('billrun.prepare', cookie.owner, { period: '2026-08' })).id}`, cookie.owner)
    assert.equal(detail.invoices.find(i => i.customer_name === 'Harbor Analytics LLC').comparison.incumbent.reconciled, true)
    // Cutover: never a period Stripe already billed.
    const shadow = await h.api('shadow', cookie.owner)
    const atlasSub = shadow.find(s => s.customer_name === 'Atlas Freight Inc')
    assert.equal(atlasSub.earliestCutover, '2026-10-01')
    await h.api('subscription.adopt', cookie.finance, { subscription: atlasSub.id, cutover_start: '2026-10-01' }, 403)
    await h.api('subscription.adopt', cookie.owner, { subscription: atlasSub.id, cutover_start: '2026-09-01' }, 409)
    await h.api('subscription.adopt', cookie.owner, { subscription: atlasSub.id, cutover_start: '2026-10-01' })
    const september = await h.api('billrun.prepare', cookie.owner, { period: '2026-09' })
    assert.ok(september.summary.skipped.some(s => s.customer === 'Atlas Freight Inc' && /previous biller/.test(s.reason)))
    // Once its records have been billed on, the move cannot be undone silently.
    const jobs = await h.api('imports', cookie.owner)
    assert.ok(jobs.find(j => j.id === again.job).blockers.length > 0)
    const blocked = await h.api('import.job', cookie.finance, { job: again.job, action: 'undo' }, 409)
    assert.equal(blocked.error, 'undo_blocked')
  })

  await check('NEC-04 a subscription with an end date still holds its meter until it ends', async () => {
    await h.api('subscription.end', cookie.owner, { subscription: ids.s1, end_date: '2027-03-01' })
    assert.equal((await h.api('subscription.create', cookie.owner, { customer: ids.northwind, start_date: '2026-12-01', price: [ids.events], quantity: [''] }, 409)).error, 'meter_already_billed')
    await h.api('subscription.create', cookie.owner, { customer: ids.northwind, start_date: '2027-03-01', price: [ids.events], quantity: [''] })
  })

  await check('CAT-002 graduated, volume, package and stair-step seats and usage', () => pricingModels(h, cookie.owner))

  await exemptionCertificates(h, cookie.owner)

  await creditPolicy(h, cookie.owner)

  await priceApprovals(h, cookie.owner)

  await priceOverrides(h, cookie.owner)

  await priceSwitches(h, cookie.owner)

  await catalogueApprovals(h, cookie.owner)

  await oneTimeBilling(h, cookie.owner)

  await reportsFlow(h, cookie.owner)
  await invoicePaginationFlow(h, cookie.owner)
  await notesFlow(h, cookie.owner)
  await notificationsFlow(h,cookie.owner)
  await metadataFlow(h,cookie.owner)

  // Every main screen renders for the owner without an error.
  for (const path of ['/app', '/app/more', '/app/settings', '/app/customers', `/app/customers/${ids.northwind}`, `/app/subscriptions/${ids.s1}`, '/app/catalog', '/app/usage', '/app/billing', `/app/billing/${ids.augustRun}`, `/app/invoices/${ids.julyNorthwind}`, '/app/receivables', '/app/proposals', '/app/import', '/app/exports', '/app/access', '/app/audit']) await h.page(path, cookie.owner)
  assert.equal((await h.raw('/app/nothing-here', { cookie: cookie.owner })).status, 404)
} finally {
  await h.close()
}
