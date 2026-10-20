// Immutable signed terms, with separate-human approval for every price ramp.
import type { Bindings } from '../auth.server'
import { requireAny, actorLabel, requireMember, type Actor } from './actor'
import { all, commit, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { cents, canonicalDecimal, micros } from './decimal'
import { requireDate } from './dates'
import { lifecycleHistory, lifecycleIntervals } from './lifecycle-records'
import { Input } from './input'
import { requireSubscription, notIssuedGuard, startsInIssuedPeriod } from './subscriptions'
import { earnedCents, minimumFor, type ContractBasis } from './commitment-rating'

interface Terms { commitments:{from:string;to:string;minimum:string;taxable:boolean}[]; included:{price:string;quantity:string;from:string;to:string}[]; ramps:{item:string;effective_date:string;price:string;quantity:number}[] }
const array=(input:Input,key:string)=>{const value=input.has(key)?input.json(key):[];insist(Array.isArray(value)&&value.length<=120,`invalid_${key}`);return value as Row[]}
export async function contractsFor(env:Bindings,id:string):Promise<(Row & {terms:Terms})[]> {
  return (await all(env,'SELECT * FROM nc_contracts WHERE subscription_id=? ORDER BY created_at,id',id)).map(r=>({...r,terms:parseJson<Terms>(r.terms_json,{commitments:[],included:[],ramps:[]}),terms_json:undefined}))
}
export async function contractBasis(env:Bindings,id:string):Promise<ContractBasis> {
  const contracts=(await contractsFor(env,id)).filter(c=>c.status==='approved')
  return {commitments:contracts.flatMap(c=>c.terms.commitments.map(w=>({contract:c.id,from:w.from,to:w.to,minimumCents:cents(w.minimum),taxable:w.taxable}))),included:contracts.flatMap(c=>c.terms.included.map(a=>({...a,contract:c.id}))),
    invoices:await Promise.all((await all(env,"SELECT id,number,period_start,period_end FROM nc_invoices WHERE subscription_id=? AND invoice_kind='recurring' AND status='issued' ORDER BY period_start",id)).map(async i=>({id:i.id,number:i.number,from:i.period_start,to:i.period_end,lines:(await all(env,'SELECT * FROM nc_invoice_lines WHERE invoice_id=? ORDER BY seq',i.id)).map(l=>({kind:l.kind,description:l.description,quantity:l.quantity,unitAmount:l.unit_amount,amountCents:l.amount_cents,taxable:!!l.taxable,priceId:l.price_id,meterId:l.meter_id,periodStart:l.period_start,periodEnd:l.period_end,evidence:parseJson<Record<string,unknown>>(l.evidence_json,{})}))})))}
}

export async function contractBurnDown(env:Bindings,id:string) {
  const basis=await contractBasis(env,id),sub=await requireSubscription(env,id),lifecycle=lifecycleIntervals(await lifecycleHistory(env,id))
  return basis.commitments.map(w=>{
    const invoices=basis.invoices.filter(i=>i.from>=w.from&&i.to<=w.to).map(i=>({id:i.id,number:i.number,earnedCents:earnedCents(i.lines),trueUpCents:i.lines.filter(l=>l.kind==='commitment_trueup'&&l.evidence.contract===w.contract&&l.periodStart===w.from).reduce((n,l)=>n+l.amountCents,0)}))
    const minimum=minimumFor({subscription:{id:sub.id,anchorDay:sub.anchor_day,startDate:sub.start_date,trialEnd:sub.trial_end,endDate:sub.end_date,billFrom:sub.cutover_start},lifecycle},w)
    const earned=invoices.reduce((n,i)=>n+i.earnedCents,0),trueup=invoices.reduce((n,i)=>n+i.trueUpCents,0)
    return {contract:w.contract,from:w.from,to:w.to,minimumCents:minimum,nominalMinimumCents:w.minimumCents,earnedCents:earned,trueUpCents:trueup,billedCents:earned+trueup,remainingCents:Math.max(0,minimum-earned-trueup),invoices}
  })
}

async function normalized(env:Bindings,sub:Row,input:Input):Promise<Terms> {
  const date=(value:unknown)=>requireDate(String(value??''),'contract_date')
  const windows=(key:string):Row[]=>array(input,key).map(w=>{const from=date(w.from),to=date(w.to);insist(from>=sub.start_date&&to>from&&Number(from.slice(8))===sub.anchor_day&&Number(to.slice(8))===sub.anchor_day,'contract_window_must_align');return {...w,from,to}})
  const commitments=windows('commitments').map(w=>({from:w.from,to:w.to,minimum:canonicalDecimal(String(w.minimum)),taxable:w.taxable===true}));commitments.forEach(w=>insist(cents(w.minimum)>0,'invalid_minimum'))
  const included=windows('included').map(w=>({from:w.from,to:w.to,price:String(w.price),quantity:canonicalDecimal(String(w.quantity))}));included.forEach(w=>insist(micros(w.quantity)>0n,'invalid_included'))
  const ramps=array(input,'ramps').map(r=>({item:String(r.item),effective_date:date(r.effective_date),price:String(r.price),quantity:Number(r.quantity)})).sort((a,b)=>a.effective_date.localeCompare(b.effective_date))
  insist(commitments.length+included.length+ramps.length>0,'empty_contract')
  const prior=(await contractsFor(env,sub.id)).filter(c=>c.status==='approved')
  const previousWindows=prior.flatMap(c=>c.terms.commitments)
  const every=[...previousWindows,...commitments].sort((a,b)=>a.from.localeCompare(b.from));insist(every.every((w,i)=>!i||every[i-1].to<=w.from),'overlapping_commitments')
  const priorIncluded=prior.flatMap(c=>c.terms.included)
  for(const [index,a] of included.entries()) {
    const price=await one(env,"SELECT p.* FROM nc_prices p WHERE p.id=? AND p.kind='unit' AND EXISTS(SELECT 1 FROM nc_items WHERE subscription_id=? AND price_id=p.id)",a.price,sub.id)
    insist(price,'included_price_not_on_subscription');insist(![...priorIncluded,...included.slice(0,index)].some(b=>a.price===b.price&&a.from<b.to&&b.from<a.to),'overlapping_included')
  }
  for(const [index,r] of ramps.entries()) {
    const item=await one(env,'SELECT i.*,p.kind,p.meter_id FROM nc_items i JOIN nc_prices p ON p.id=i.price_id WHERE i.id=? AND i.subscription_id=?',r.item,sub.id)
    const price=await one(env,"SELECT * FROM nc_prices WHERE id=? AND status='active'",r.price)
    insist(item&&price,'ramp_item_or_price_not_found');insist(price.kind===item.kind&&(price.meter_id??'')===(item.meter_id??''),'ramp_incompatible_price')
    insist(r.effective_date>item.effective_from&&(!item.effective_to||r.effective_date<item.effective_to),'invalid_ramp_date')
    insist(Number.isSafeInteger(r.quantity)&&r.quantity>=(price.kind==='seat'&&price.pricing_model!=='simple'?0:1)&&r.quantity<=1_000_000&&(price.kind==='seat'||r.quantity===1),'invalid_quantity')
    insist(!ramps.slice(0,index).some(p=>p.item===r.item&&p.effective_date===r.effective_date),'duplicate_ramp_date')
  }
  for(const from of [...commitments.map(w=>w.from),...included.map(w=>w.from),...ramps.map(r=>r.effective_date)]) insist(!await startsInIssuedPeriod(env,sub.id,from),'period_already_invoiced',409)
  return {commitments,included,ramps}
}

function formTerms(input:Input):Input {
  const list=(name:string)=>input.list(name,{keepEmpty:true})
  const starts=list('commitment_from'),ends=list('commitment_to'),minimums=list('commitment_minimum'),taxes=list('commitment_taxable')
  const prices=list('included_price'),quantities=list('included_quantity'),from=list('included_from'),to=list('included_to')
  const items=list('ramp_item'),dates=list('ramp_date'),targets=list('ramp_price'),seats=list('ramp_quantity')
  return Input.of({commitments:starts.flatMap((v,i)=>v?[{from:v,to:ends[i],minimum:minimums[i],taxable:taxes[i]==='true'}]:[]),
    included:prices.flatMap((v,i)=>v?[{price:v,quantity:quantities[i],from:from[i],to:to[i]}]:[]),
    ramps:items.flatMap((v,i)=>v?[{item:v,effective_date:dates[i],price:targets[i],quantity:Number(seats[i])}]:[])})
}

export async function prepareContract(env:Bindings,actor:Actor,input:Input) {
  requireAny(actor,['records','draft'])
  insist(actor.kind==='member','person_required',403)
  const sub=await requireSubscription(env,input.text('subscription',{max:100}));insist(sub.revision===input.text('revision',{max:100}),'stale',409)
  const clause=input.text('clause',{max:10000}),terms=await normalized(env,sub,input.has('commitments')||input.has('included')||input.has('ramps')?input:formTerms(input)),id=newId()
  await commit(env,[guard(env,'stale','EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=?)',sub.id,sub.revision),stmt(env,"INSERT INTO nc_contracts (id,subscription_id,subscription_revision,clause,terms_json,status,prepared_by_id,prepared_by,created_at) VALUES (?,?,?,?,?,'proposed',?,?,?)",id,sub.id,sub.revision,clause,JSON.stringify(terms),actor.id,actorLabel(actor),now())],{actor:actorLabel(actor),action:'contract.prepare',subject:id,detail:{subscription:sub.id,terms,clause}})
  return {id:sub.id,contract:id}
}

export async function decideContract(env:Bindings,actor:Actor,input:Input) {
  requireMember(actor,'approve')
  const record=await one(env,'SELECT * FROM nc_contracts WHERE id=?',input.text('contract',{max:100}));insist(record,'contract_not_found',404);insist(record.status==='proposed','already_decided',409)
  const decision=input.text('decision',{max:20});insist(['approved','rejected'].includes(decision),'invalid_decision')
  const sub=await requireSubscription(env,record.subscription_id),statements=[guard(env,'already_decided',"EXISTS(SELECT 1 FROM nc_contracts WHERE id=? AND status='proposed')",record.id)]
  if(decision==='approved') {
    insist(record.prepared_by_id!==actor.id,'second_approver_required',409);insist(sub.revision===record.subscription_revision,'stale',409)
    const terms=parseJson<Terms>(record.terms_json,{commitments:[],included:[],ramps:[]});await normalized(env,sub,Input.of(terms as unknown as Row))
    statements.push(guard(env,'stale','EXISTS(SELECT 1 FROM nc_subscriptions WHERE id=? AND revision=?)',sub.id,record.subscription_revision))
    for(const from of [...terms.commitments.map(w=>w.from),...terms.included.map(w=>w.from),...terms.ramps.map(r=>r.effective_date)])statements.push(notIssuedGuard(env,sub.id,from))
    for(const itemId of new Set(terms.ramps.map(r=>r.item))) {
      const item=(await one(env,'SELECT * FROM nc_items WHERE id=?',itemId))!,ramps=terms.ramps.filter(r=>r.item===itemId)
      statements.push(stmt(env,'UPDATE nc_items SET effective_to=? WHERE id=?',ramps[0].effective_date,itemId))
      for(const [index,r] of ramps.entries())statements.push(stmt(env,"INSERT INTO nc_items(id,subscription_id,price_id,quantity,effective_from,effective_to,origin,created_at) VALUES(?,?,?,?,?,?,'native',?)",newId(),sub.id,r.price,r.quantity,r.effective_date,ramps[index+1]?.effective_date??item.effective_to,now()))
    }
    statements.push(stmt(env,'UPDATE nc_subscriptions SET revision=?,updated_at=? WHERE id=?',newId(),now(),sub.id))
  }
  statements.push(stmt(env,'UPDATE nc_contracts SET status=?,decided_by=?,decided_at=? WHERE id=?',decision,actorLabel(actor),now(),record.id))
  await commit(env,statements,{actor:actorLabel(actor),action:`contract.${decision}`,subject:record.id,detail:{subscription:sub.id,preparedBy:record.prepared_by,terms:parseJson(record.terms_json,{})}})
  return {id:sub.id,status:decision}
}
