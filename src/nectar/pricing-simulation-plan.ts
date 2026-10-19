import { serviceEndSql } from './renewal-sql'
// Historical replay and an executable future cohort share one immutable proposal.
import type { Bindings } from '../auth.server'
import type { Business } from './business'
import { all, fingerprint, insist, one, type Row } from './core'
import { periodContaining,addMonths } from './dates'
import { ratingInputs } from './inputs'
import { uniqueMeterItems } from './metric-ownership'
import { pricingReplay } from './pricing-replay'
import { rate, type ItemIn, type RatingInput, type Rating } from './rating'
import { money } from './decimal'
import { startsInIssuedPeriod } from './subscriptions'

export async function pricingSimulationPlan(env: Bindings, business: Business, payload: Row) {
  const replay = await pricingReplay(env, business, payload)
  const target = await one(env, 'SELECT p.*,COALESCE(m.source_meter_id,p.meter_id) AS source_meter_id FROM nc_prices p LEFT JOIN nc_meters m ON m.id=p.meter_id WHERE p.id=?', replay.normalized.target_price)
  insist(target, 'price_not_found', 404)
  const product = await one(env, 'SELECT id FROM nc_products WHERE id=? AND status=\'active\'', target.product_id)
  insist(product, 'product_not_found', 404)
  const version = (await one(env,'SELECT MAX(version) AS v FROM nc_prices WHERE product_id=?',target.product_id))!.v
  const basis:Row={productVersion:[target.product_id,version],ratings:{},replay:replay.basis}
  const impact:Row[]=[]
  for(const historical of replay.impact.customers) {
    const sub=await one(env,'SELECT s.*,c.name AS customer_name,c.billing_email FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id WHERE s.id=?',historical.subscription)
    insist(sub && sub.billing_mode==='live','subscription_not_live',409)
    const date=replay.normalized.effective_date
    const term=await one(env,"SELECT * FROM nc_renewal_terms WHERE subscription_id=? AND status='active'",sub.id)
    const renews=term?.auto_renew&&!term.cancelled_at&&date===term.end_date
    insist(date>=sub.start_date && (!sub.end_date || date<sub.end_date || renews) && (!sub.cutover_start || date>=sub.cutover_start),'invalid_effective_date')
    insist(!term||date>=term.end_date,'signed_term_grandfathered',409)
    insist(!await startsInIssuedPeriod(env,sub.id,date),'period_already_invoiced',409)
    const sourceItems=await all(env,'SELECT * FROM nc_items WHERE subscription_id=? AND price_id=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>?) ORDER BY id',sub.id,replay.normalized.source_price,date,date)
    insist(sourceItems.length,'subscription_not_on_price',409)
    const sourceIds=new Set(sourceItems.map(i=>i.id))
    const current=await ratingInputs(env,business,sub.id,periodContaining(sub.anchor_day,date))
    const moved:ItemIn[]=[...current.items.filter(i=>!sourceIds.has(i.id)||i.from!==date).map(i=>sourceIds.has(i.id)?{...i,to:date}:i),...sourceItems.map((i,index)=>({id:`proposed-item-${index}`,priceId:target.id,quantity:target.kind==='seat'?(replay.normalized.quantity??i.quantity):1,from:date,to:i.effective_to}))]
    await uniqueMeterItems(env,moved)
    if(target.meter_id) {
      const clash=await one(env,`SELECT 1 FROM nc_items i JOIN nc_prices p ON p.id=i.price_id LEFT JOIN nc_meters m ON m.id=p.meter_id JOIN nc_subscriptions s ON s.id=i.subscription_id WHERE s.customer_id=? AND s.id<>? AND COALESCE(m.source_meter_id,p.meter_id)=? AND MAX(s.start_date,i.effective_from,?)<MIN(${serviceEndSql()},COALESCE(i.effective_to,'9999-12-31'),?)`,sub.customer_id,sub.id,target.source_meter_id,date,sub.end_date??'9999-12-31')
      insist(!clash,'meter_already_billed',409)
    }
    const periods=[],fingerprints=[]
    const priorBefore:{input:RatingInput;rating:Rating}[]=[],priorAfter:{input:RatingInput;rating:Rating}[]=[]
    const remaining=(input:RatingInput,prior:{input:RatingInput;rating:Rating}[]):RatingInput=>{
      const consumed=new Set(prior.flatMap(p=>p.rating.consumedEvents))
      const charged=new Set(prior.flatMap(p=>(p.input.charges??[]).map(c=>c.id)))
      return {...input,events:input.events.filter(e=>!consumed.has(e.eventId)),...(input.charges?{charges:input.charges.filter(c=>!charged.has(c.id))}:{}),
        ...(input.contracts?{contracts:{...input.contracts,invoices:[...input.contracts.invoices,...prior.map(p=>({id:`projected-${sub.id}-${p.input.period.start}`,number:'Projected invoice',from:p.input.period.start,to:p.input.period.end,lines:p.rating.lines}))]}}:{})}
    }
    const first=periodContaining(sub.anchor_day,date)
    for(const period of Array.from({length:term?.months??2},(_,i)=>({start:addMonths(first.start,i),end:addMonths(first.start,i+1)}))) {
      const before=remaining(await ratingInputs(env,business,sub.id,period),priorBefore)
      const after=remaining(await ratingInputs(env,business,sub.id,period,moved),priorAfter)
      if(renews)for(const input of [before,after]){input.subscription.endDate=addMonths(term.end_date,term.months);input.renewals=[...(input.renewals??[]),{id:`term-${term.id}`,effectiveDate:date,upliftPercent:term.uplift_percent}];input.version='nectar-rating-8'}
      // Existing signed exceptions remain tied to their signed source prices;
      // changing them requires a separate approved contract amendment.
      const prior=rate(before),next=rate(after)
      insist(!next.exceptions.some(e=>['metric_duplicate_selection','metric_negative_quantity','metric_late_correction'].includes(e.code)),'simulation_blocked',409,next.exceptions)
      fingerprints.push(await fingerprint({before,after}))
      periods.push({period,before:prior,after:next})
      priorBefore.push({input:before,rating:prior});priorAfter.push({input:after,rating:next})
    }
    basis[sub.id]=sub.revision;basis.ratings[sub.id]=fingerprints
    const firstHistorical=historical.periods[0],lastHistorical=historical.periods.at(-1)!
    const notice={status:'prepared',recipient:sub.billing_email,effectiveDate:date,subject:'Proposed pricing change',body:`Your pricing changes on ${date}. Replaying invoices ${firstHistorical.invoiceNumber} through ${lastHistorical.invoiceNumber} under the proposed catalog price changes the ${historical.periods.length}-period subtotal from ${money(historical.totals.beforeSubtotalCents)} to ${money(historical.totals.afterSubtotalCents)}. These are historical comparisons, not a forecast.`,invoiceIds:historical.periods.map(p=>p.invoice)}
    impact.push({subscription:sub.id,subscriptionLabel:sub.external_id||sub.id,customer:sub.customer_name,effective_date:date,sourceItems:sourceItems.map(i=>({id:i.id,quantity:i.quantity,targetQuantity:target.kind==='seat'?(replay.normalized.quantity??i.quantity):1})),quantity:sourceItems.length,periods,historical,notice,...(impact.length===0?{simulationSummary:{totals:replay.impact.totals,highestAffectedCustomers:replay.impact.highestAffectedCustomers,explanation:replay.impact.explanation,assumptions:replay.impact.assumptions,...(replay.impact.costAssumption?{costAssumption:replay.impact.costAssumption}:{})}}:{})})
  }
  return {normalized:{...replay.normalized,simulation:true,product:target.product_id,kind:target.kind,unit_amount:target.unit_amount,meter:target.meter_id,taxable:!!target.taxable,timing:'date',resolved_dates:Object.fromEntries(impact.map(e=>[e.subscription,e.effective_date]))},impact,basis}
}
