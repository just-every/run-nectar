import { linkApprovalSql,otherLinkApprover } from './payment-links-approval'
import { paymentLinkRenewalSettings } from './payment-links-renewals'
// Owner management freezes native catalog and reviewed tax terms. Hosted signup
// captures a card, never creates a second processor subscription or a debit.
import type { Bindings } from '../auth.server'
import { actorLabel, requireOwner,requireMember, type Actor } from './actor'
import { requireBusiness, taxReady } from './business'
import { clockInstant } from './clock'
import { all, canonical, commit, fingerprint, guard, insist, newId, one, parseJson, stmt, type Row } from './core'
import { cents, lineCents, micros, percentOf, SCALE } from './decimal'
import { setupOwner, setupOwnerFence } from './hosted-setup-basis'
import type { Input } from './input'
import { paymentLinkStripe } from './payment-links-stripe'
import { paymentLinkPromotion, paymentLinkPromotionGuard } from './payment-links-promotions'

export interface LinkItem { price: string; product: string; description: string; quantity: number; unitAmount: string; taxable: boolean; timing: 'advance'|'arrears'; amountCents: number }
export interface LinkTerms { v: 1; kind:'subscription'|'one_time'; merchant: string; timezone: string; currency: 'USD'; items: LinkItem[]; oneTime:{description:string;amountCents:number;taxable:boolean}|null; trialDays: number; renewal:{months:number;auto_renew:number;notice_days:number;uplift_percent:string}|null; promotionCode: string|null; promotion:Row|null; tax: { mode: string; rate: string; jurisdiction: string; reviewedAt: number }; subtotalCents: number; taxCents: number; totalCents: number; debitAuthority: false }

export async function paymentLinkPrices(env: Bindings) {
  return all(env, `SELECT p.*,pr.name AS product_name,b.interval_unit,b.interval_count,b.billing_timing
    FROM nc_prices p JOIN nc_products pr ON pr.id=p.product_id LEFT JOIN nc_price_intervals b ON b.price_id=p.id
    WHERE p.status='active' AND p.currency='USD' AND p.kind IN ('flat','seat') AND p.pricing_model='simple'
    AND (b.price_id IS NULL OR (b.interval_unit='month' AND b.interval_count=1)) ORDER BY pr.name,p.version`)
}
export const linkTerms = (row: Row) => parseJson<LinkTerms>(row.terms_json, null as never)
export async function frozenPaymentLinkTerms(row:Row,attempt:Row) {
  const terms=linkTerms(row),consent=parseJson<Row>(attempt.consent_json,{})
  insist(await fingerprint(terms)===row.basis_hash&&consent.basis===row.basis_hash&&consent.link===row.id
    &&consent.monthlyTotal===terms.totalCents,'payment_link_terms_changed',409)
  return terms
}
export const paymentLinkCaptureGuard=(env:Bindings,link:Row,row:Row)=>guard(env,'payment_link_evidence_mismatch',`EXISTS(SELECT 1 FROM nc_payment_links l JOIN nc_payment_link_attempts a ON a.link_id=l.id
  WHERE l.id=? AND l.basis_hash=? AND a.id=? AND json_extract(a.consent_json,'$.basis')=l.basis_hash
  AND json_extract(a.consent_json,'$.monthlyTotal')=json_extract(l.terms_json,'$.totalCents'))`,link.id,link.basis_hash,row.id)
export const linkOwnerGuard = (env: Bindings, row: Row) => guard(env,'payment_link_owner_unavailable',
  `EXISTS(SELECT 1 FROM nc_payment_links l ${linkApprovalSql} JOIN nc_payment_link_activations a ON a.link_id=l.id JOIN nc_members m ON m.id=a.created_by JOIN oa_operators o ON lower(o.email)=m.email WHERE l.id=? AND l.approval_status='approved' AND m.role='owner' AND m.status='active' AND o.role='owner' AND o.status='active')`,row.id)
export const activeLinkGuard = (env: Bindings, row: Row) => guard(env,'payment_link_unavailable',
  "EXISTS(SELECT 1 FROM nc_payment_links WHERE id=? AND status='active' AND revision=?)",row.id,row.revision)

export async function requireActivePaymentLink(env: Bindings, id: string) {
  const row = await one(env,`SELECT l.* FROM nc_payment_links l ${linkApprovalSql} JOIN nc_payment_link_activations a ON a.link_id=l.id JOIN nc_members m ON m.id=a.created_by AND m.role='owner' AND m.status='active' JOIN oa_operators o ON lower(o.email)=m.email AND o.role='owner' AND o.status='active' WHERE l.id=? AND l.status='active' AND l.approval_status='approved'`,id)
  insist(row,'payment_link_unavailable',404)
  return row
}
export async function currentLinkTerms(env: Bindings, row: Row, requireActivation=true) {
  if(requireActivation)await requireActivePaymentLink(env,row.id)
  const saved=linkTerms(row),business=await requireBusiness(env),prices=await paymentLinkPrices(env)
  insist(taxReady(business) && business.legal_name===saved.merchant && business.timezone===saved.timezone
    && business.tax_mode===saved.tax.mode && business.tax_rate===saved.tax.rate && business.tax_jurisdiction===saved.tax.jurisdiction
    && business.tax_reviewed_at===saved.tax.reviewedAt,'payment_link_terms_changed',409)
  for(const item of saved.items) {
    const price=prices.find(price=>price.id===item.price)
    insist(price && price.unit_amount===item.unitAmount && price.product_id===item.product && !!price.taxable===item.taxable
      && (price.billing_timing??'arrears')===item.timing,'payment_link_terms_changed',409)
  }
  const promotion=await paymentLinkPromotion(env,saved.promotionCode??'',saved.items,saved.timezone)
  insist(canonical(promotion)===canonical(saved.promotion),'payment_link_terms_changed',409)
  insist(await fingerprint(saved)===row.basis_hash,'payment_link_terms_changed',409)
  return saved
}
export function linkTermsGuards(env: Bindings, terms: LinkTerms) {
  return [guard(env,'payment_link_terms_changed',`EXISTS(SELECT 1 FROM nc_business WHERE singleton=1 AND legal_name=? AND timezone=? AND tax_mode=? AND tax_rate=? AND tax_jurisdiction=? AND tax_reviewed_at=?)`,terms.merchant,terms.timezone,terms.tax.mode,terms.tax.rate,terms.tax.jurisdiction,terms.tax.reviewedAt),
    ...terms.items.map(item=>guard(env,'payment_link_terms_changed',`EXISTS(SELECT 1 FROM nc_prices p LEFT JOIN nc_price_intervals b ON b.price_id=p.id WHERE p.id=? AND p.status='active' AND p.currency='USD' AND p.product_id=? AND p.unit_amount=? AND p.taxable=? AND COALESCE(b.billing_timing,'arrears')=? AND (b.price_id IS NULL OR (b.interval_unit='month' AND b.interval_count=1)))`,item.price,item.product,item.unitAmount,item.taxable?1:0,item.timing)),
    ...(terms.promotion?[paymentLinkPromotionGuard(env,terms.promotion)]:[])]
}

export async function createPaymentLink(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor);const factor=await setupOwner(env,actor)
  input.only(['name','kind','price','quantity','amount','description','taxable','trial_days','promotion_code','max_uses','confirm','confirm_single','months','auto_renew','notice_days','uplift_percent','returnTo'])
  insist(input.flag('confirm'),'payment_link_confirmation_required')
  const business=await requireBusiness(env);insist(taxReady(business),'tax_review_required',409)
  const kind=input.text('kind',{max:20,optional:true})||'subscription';insist(kind==='subscription'||kind==='one_time','invalid_payment_link_kind')
  const selections=input.list('price',{keepEmpty:true}),quantities=input.list('quantity',{keepEmpty:true}),prices=await paymentLinkPrices(env)
  const lines=selections.map((id,index)=>({id,quantity:quantities[index]})).filter(line=>line.id),ids=lines.map(line=>line.id)
  insist(kind==='one_time'?ids.length===0:ids.length>0 && ids.length<=20 && new Set(ids).size===ids.length,'items_required')
  const items: LinkItem[]=ids.map((id,index)=>{
    const price=prices.find(price=>price.id===id);insist(price,'payment_link_price_unsupported',409)
    const quantity=price.kind==='seat'?Number(lines[index].quantity??'1'):1
    insist(Number.isSafeInteger(quantity)&&quantity>=1&&quantity<=1000000,'invalid_quantity')
    return {price:id,product:price.product_id,description:`${price.product_name} · ${price.nickname}`,quantity,unitAmount:price.unit_amount,taxable:!!price.taxable,timing:price.billing_timing??'arrears',amountCents:Number(lineCents(micros(price.unit_amount),BigInt(quantity)*SCALE))}
  })
  const oneTime=kind==='one_time'?{description:input.text('description',{max:300}),amountCents:cents(input.text('amount',{max:20})),taxable:input.flag('taxable')}:null
  const subtotalCents=oneTime?.amountCents??items.reduce((sum,item)=>sum+item.amountCents,0)
  const taxable=oneTime?(oneTime.taxable?subtotalCents:0):items.filter(item=>item.taxable).reduce((sum,item)=>sum+item.amountCents,0)
  const taxCents=business.tax_mode==='flat_rate'?Number(percentOf(BigInt(taxable),micros(business.tax_rate))):0
  insist(Number.isSafeInteger(subtotalCents+taxCents)&&subtotalCents+taxCents<=99999999,'invalid_amount')
  // Promotion application remains the existing native redemption path; checkout
  // never independently discounts the same subscription at the processor.
  const promotion=await paymentLinkPromotion(env,input.text('promotion_code',{max:40,optional:true}),items,business.timezone)
  const promotionCode=promotion?.code??null
  const trialDays=input.integer('trial_days',{min:0,max:365,optional:true})??0
  insist(kind==='subscription'||trialDays===0&&!promotionCode&&subtotalCents>=50,'payment_link_one_time_terms_invalid')
  const terms: LinkTerms={v:1,kind,merchant:business.legal_name,timezone:business.timezone,currency:'USD',items,oneTime,
    trialDays,renewal:kind==='subscription'?paymentLinkRenewalSettings(input):null,promotionCode,promotion,
    tax:{mode:business.tax_mode,rate:business.tax_rate,jurisdiction:business.tax_jurisdiction,reviewedAt:business.tax_reviewed_at!},subtotalCents,taxCents,totalCents:subtotalCents+taxCents,debitAuthority:false}
  const selected=await paymentLinkStripe(env,null),account=await selected.stripe('/account')
  insist(account.object==='account'&&account.id===selected.account,'stripe_account_evidence_invalid',409)
  const id=newId(),at=clockInstant(env),revision=newId(),basis=await fingerprint(terms)
  const independent=kind==='subscription'&&!!await one(env,otherLinkApprover,actor.id)
  if(kind==='subscription'&&!independent)insist(input.flag('confirm_single'),'single_confirmation_required',409)
  const approved=!independent
  await commit(env,[...setupOwnerFence(env,actor),...linkTermsGuards(env,terms),
    ...(kind==='subscription'?[guard(env,'payment_link_approvers_changed',`${independent?'EXISTS':'NOT EXISTS'}(${otherLinkApprover})`,actor.id)]:[]),
    stmt(env,`INSERT INTO nc_payment_links(id,name,status,terms_json,basis_hash,account_ref,max_uses,created_by,created_at,revision,approval_status,approved_by,approved_at,approval_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,input.text('name',{max:160}),approved?'active':'inactive',canonical(terms),basis,selected.account,input.integer('max_uses',{min:1,max:1000000,optional:true}),actor.id,at,revision,approved?'approved':'pending',approved?actor.id:null,approved?at:null,approved?(kind==='subscription'?'single-approver':'owner-policy'):null),
    ...(approved?[stmt(env,'INSERT INTO nc_payment_link_activations(id,link_id,created_by,factor_ref,created_at) VALUES(?,?,?,?,?)',newId(),id,actor.id,factor.reference,at)]:[])],
    {actor:actorLabel(actor),action:'payment_link.create',subject:id,detail:{basis,account:selected.account,testMode:true,debitAuthority:false,approval:approved?'approved':'pending'}})
  return {id,path:`/pay-links/${id}`,revision}
}
export async function deactivatePaymentLink(env: Bindings, actor: Actor, input: Input) {
  requireOwner(actor)
  input.only(['link','revision','returnTo'])
  const id=input.text('link',{max:100}),revision=input.text('revision',{max:100})
  await commit(env,[guard(env,'owner_required',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role='owner')",actor.id),guard(env,'stale',"EXISTS(SELECT 1 FROM nc_payment_links WHERE id=? AND revision=? AND status='active')",id,revision),stmt(env,"UPDATE nc_payment_links SET status='inactive',deactivated_at=?,revision=? WHERE id=?",clockInstant(env),newId(),id),stmt(env,'DELETE FROM nc_payment_link_activations WHERE link_id=?',id)],{actor:actorLabel(actor),action:'payment_link.deactivate',subject:id})
  return {id}
}
export async function activatePaymentLink(env:Bindings,actor:Actor,input:Input) {
  requireOwner(actor);const factor=await setupOwner(env,actor)
  input.only(['link','revision','confirm','returnTo']);insist(input.flag('confirm'),'payment_link_confirmation_required')
  const id=input.text('link',{max:100}),row=await one(env,'SELECT * FROM nc_payment_links WHERE id=?',id)
  insist(row&&row.revision===input.text('revision',{max:100}),'stale',409)
  insist(row.approval_status==='approved'&&await one(env,`SELECT 1 FROM nc_payment_links l ${linkApprovalSql} WHERE l.id=?`,row.id),'payment_link_approval_required',409)
  const terms=await currentLinkTerms(env,row,false);await paymentLinkStripe(env,row.account_ref)
  await commit(env,[...setupOwnerFence(env,actor),...linkTermsGuards(env,terms),guard(env,'stale','EXISTS(SELECT 1 FROM nc_payment_links WHERE id=? AND revision=?)',row.id,row.revision),
    stmt(env,"UPDATE nc_payment_links SET status='active',deactivated_at=NULL,revision=? WHERE id=?",newId(),id),
    stmt(env,'INSERT INTO nc_payment_link_activations(id,link_id,created_by,factor_ref,created_at) VALUES(?,?,?,?,?) ON CONFLICT(link_id) DO UPDATE SET id=excluded.id,created_by=excluded.created_by,factor_ref=excluded.factor_ref,created_at=excluded.created_at',newId(),id,actor.id,factor.reference,clockInstant(env))],
    {actor:actorLabel(actor),action:'payment_link.activate',subject:id,detail:{basis:row.basis_hash,testMode:true}})
  return {id}
}
export async function readPaymentLinks(env: Bindings, actor: Actor) {
  requireMember(actor,'approve')
  return (await all(env,'SELECT l.*,EXISTS(SELECT 1 FROM nc_payment_link_activations a WHERE a.link_id=l.id) AS activated FROM nc_payment_links l ORDER BY created_at DESC,id')).map(row=>({id:row.id,name:row.name,status:row.status,approvalStatus:row.approval_status,preparedBy:row.created_by,approvedBy:row.approved_by,approvalMode:row.approval_mode,basis:row.basis_hash,activated:!!row.activated,revision:row.revision,path:`/pay-links/${row.id}`,maxUses:row.max_uses,uses:row.used_count,reserved:row.reserved_count,terms:linkTerms(row)}))
}
