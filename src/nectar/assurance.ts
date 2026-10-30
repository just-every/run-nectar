import { MOVE_KIND, moveInvestigationEvidence } from './movein/investigations'
// Current assurance coverage: recorded source controls versus ingested usage, and signed seat and ramp
// steps versus issued invoices. A scan owns only case records. Financial fixes keep their existing approvals.
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, requireMember, type Actor } from './actor'
import { all, canonical, commit, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { cents } from './decimal'
import { isMonth } from './dates'
import type { Input } from './input'
import { controlTotals } from './reconciliation'
import { RAMP_KIND, rampEvidence } from './assurance-ramps'
import { TRUEUP_KIND, trueUpEvidence } from './assurance-commitments'
import { CREDIT_KIND, creditEvidence } from './assurance-credits'
import { ACCESS_KIND, accessEvidence } from './assurance-access'
import { PAID_KIND, paidAccessEvidence } from './assurance-paid-access'

// Each detector compares signed terms with recorded facts and returns one evidence record per subject.
// Built on use: the detector modules import doors that import this one.
const detectors = (): Record<string, (env: Bindings) => Promise<Row[]>> => ({
  [RAMP_KIND]: rampEvidence, [TRUEUP_KIND]: trueUpEvidence, [CREDIT_KIND]: creditEvidence, [ACCESS_KIND]: accessEvidence, [PAID_KIND]: paidAccessEvidence, [MOVE_KIND]: moveInvestigationEvidence,
})

function investigator(actor: Actor) {
  requireCapability(actor, 'read')
  requireCapability(actor, 'propose')
}

async function sequence(env: Bindings) {
  return (await one(env,'SELECT COALESCE(MAX(seq),0) AS seq FROM nc_audit'))!.seq
}
const unchanged = (env: Bindings, seq: number) => guard(env,'assurance_source_changed','(SELECT COALESCE(MAX(seq),0) FROM nc_audit)=?',seq)
const ownerGuard = (env: Bindings, id: string) => guard(env,'assurance_owner_unavailable',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance'))",id)

async function activeOwner(env: Bindings, id: string) {
  insist(await one(env,"SELECT id FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance')",id),'assurance_owner_unavailable',409)
}

// No customer names, emails, event properties or caller-written evidence enter a case.
function evidence(row: Row) {
  return { kind:'usage_source_control', source:row.id, customer:row.customer, meter:row.meter, day:row.day,
    expectedCount:row.expectedCount, actualCount:row.actualCount, expectedQuantity:row.expectedQuantity,
    actualQuantity:row.actualQuantity, countDifference:row.countDifference, quantityDifference:row.quantityDifference,
    mismatch:row.mismatch, basis:row.basis }
}

async function current(env: Bindings, actor: Actor, row: Row): Promise<Row> {
  insist(!await one(env,'SELECT 1 FROM nc_customers WHERE id=? AND erased_at IS NOT NULL',row.customer_id),'assurance_case_not_found',404)
  const detector=detectors()[row.kind]
  if(detector) {
    const compared=(await detector(env)).find(c=>c.source===row.source_id)
    insist(compared,'assurance_source_unavailable',409)
    return compared
  }
  const control=await one(env,'SELECT day FROM nc_usage_controls WHERE id=?',row.source_id)
  insist(control,'assurance_source_unavailable',409)
  const compared=(await controlTotals(env,actor,control.day.slice(0,7))).find(c=>c.id===row.source_id)
  insist(compared,'assurance_source_unavailable',409)
  return evidence(compared)
}

const project = (row: Row): Row => ({...row,evidence:parseJson(row.evidence_json,{}),evidence_json:undefined})

export async function assuranceCases(env: Bindings, actor: Actor): Promise<Row[]> {
  requireCapability(actor,'read')
  const rows=await all(env,'SELECT a.* FROM nc_assurance_cases a JOIN nc_customers c ON c.id=a.customer_id WHERE c.erased_at IS NULL ORDER BY a.created_at,a.id')
  const live=rows.some(row=>row.kind===MOVE_KIND)?await moveInvestigationEvidence(env):[]
  return rows.map(row=>({...project(row),...(row.kind===MOVE_KIND?{stale:live.find(proof=>proof.source===row.source_id)?.basis!==row.basis_hash}:{} )}))
}

export async function assuranceCase(env: Bindings, actor: Actor, id: string): Promise<Row> {
  requireCapability(actor,'read')
  const row=await one(env,'SELECT a.* FROM nc_assurance_cases a JOIN nc_customers c ON c.id=a.customer_id WHERE a.id=? AND c.erased_at IS NULL',id)
  insist(row,'assurance_case_not_found',404)
  const live = row.kind===MOVE_KIND ? await current(env,actor,row).catch(()=>null) : null
  return {...project(row),...(row.kind===MOVE_KIND?{stale:!live||live.basis!==row.basis_hash,currentEvidence:live}:{}),observations:(await all(env,'SELECT * FROM nc_assurance_observations WHERE case_id=? ORDER BY created_at,id',id)).map(project)}
}

export async function scanAssurance(env: Bindings, actor: Actor, input: Input) {
  investigator(actor)
  const period=input.text('period',{max:7}),owner=input.text('owner',{max:100})
  insist(isMonth(period),'invalid_period')
  return await scanCases(env,actor,[period],owner,period)
}

/** One comparison pass over every detector. The scheduled run and the explicit door share it, so a repeated
 * pass is idempotent: an existing subject is rechecked in place and a new mismatch opens exactly one case. */
export async function scanCases(env: Bindings, actor: Actor, periods: string[], owner: string, subject: string, selectedProofs?: () => Promise<Row[]>) {
  await activeOwner(env,owner)
  const seq=await sequence(env), controls=(await Promise.all(periods.map(period=>controlTotals(env,actor,period)))).flat()
  const statements:D1PreparedStatement[]=[unchanged(env,seq),ownerGuard(env,owner)]
  const opened:string[]=[],rechecked:string[]=[]
  const proofs:Row[]=[]
  for(const row of controls) {
    // An erased customer's source controls are retained financial facts only.
    if(await one(env,'SELECT 1 FROM nc_customers WHERE id=? AND erased_at IS NOT NULL',row.customer))continue
    proofs.push(evidence(row))
  }
  if(selectedProofs) proofs.push(...await selectedProofs())
  else for(const detect of Object.values(detectors()))proofs.push(...await detect(env))
  for(const proof of proofs) {
    const existing=await one(env,'SELECT * FROM nc_assurance_cases WHERE source_id=?',proof.source)
    if(existing) {
      const status=!proof.mismatch && existing.approved_basis===proof.basis?'resolved':'open'
      if(existing.basis_hash!==proof.basis || existing.status!==status) {
        statements.push(ownerGuard(env,existing.owner_id),...observationStatements(env,actor,existing,proof))
        rechecked.push(existing.id)
      }
      continue
    }
    if(!proof.mismatch)continue
    const id=newId(),at=now()
    opened.push(id)
    statements.push(stmt(env,"INSERT INTO nc_assurance_cases(id,customer_id,kind,source_id,owner_id,status,basis_hash,evidence_json,created_at,checked_at) VALUES(?,?,?,?,?,'open',?,?,?,?)",id,proof.customer,proof.kind,proof.source,owner,proof.basis,canonical(proof),at,at),
      stmt(env,"INSERT INTO nc_assurance_observations(id,customer_id,case_id,basis_hash,evidence_json,status,created_by,created_at) VALUES(?,?,?,?,?,'open',?,?)",newId(),proof.customer,id,proof.basis,canonical(proof),actorLabel(actor),at))
  }
  const coverage=selectedProofs?[MOVE_KIND]:['usage_source_control',...Object.keys(detectors())]
  await commit(env,statements,{actor:actorLabel(actor),action:'assurance.scan',subject,detail:{coverage,compared:proofs.length,opened,rechecked}})
  return {coverage,compared:proofs.length,opened,rechecked}
}

export async function assignAssurance(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor,'approve')
  requireCapability(actor,'read')
  const id=input.text('case',{max:100}),owner=input.text('owner',{max:100})
  const row=await assuranceCase(env,actor,id)
  await activeOwner(env,owner)
  await commit(env,[ownerGuard(env,owner),guard(env,'assurance_case_changed','EXISTS(SELECT 1 FROM nc_assurance_cases WHERE id=? AND owner_id=?)',id,row.owner_id),stmt(env,'UPDATE nc_assurance_cases SET owner_id=? WHERE id=?',owner,id)],{actor:actorLabel(actor),action:'assurance.assign',subject:id,detail:{owner}})
  return {id,owner}
}

// A person confirms agreement, never waives a mismatch or approves an adjustment here.
export async function approveAssurance(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor,'approve')
  requireCapability(actor,'read')
  const seq=await sequence(env),id=input.text('case',{max:100}),basis=input.text('basis',{max:100})
  const row=await assuranceCase(env,actor,id),proof=await current(env,actor,row)
  insist(row.status==='open','assurance_case_resolved',409)
  insist(!proof.mismatch,'assurance_mismatch_remains',409)
  insist(proof.basis===basis,'assurance_source_changed',409)
  const at=now()
  await commit(env,[unchanged(env,seq),ownerGuard(env,row.owner_id),stmt(env,'UPDATE nc_assurance_cases SET approved_basis=?,approved_by=?,approved_at=? WHERE id=?',basis,actorLabel(actor),at,id)],{actor:actorLabel(actor),action:'assurance.approve',subject:id,detail:{basis}})
  return {id,basis}
}

function observationStatements(env: Bindings, actor: Actor, row: Row, proof: Row) {
  const at=now(),keepApproval=!proof.mismatch && row.approved_basis===proof.basis
  const status=keepApproval?'resolved':'open'
  return [
    stmt(env,'UPDATE nc_assurance_cases SET status=?,basis_hash=?,evidence_json=?,checked_at=?,approved_basis=?,approved_by=?,approved_at=? WHERE id=?',status,proof.basis,canonical(proof),at,keepApproval?row.approved_basis:null,keepApproval?row.approved_by:null,keepApproval?row.approved_at:null,row.id),
    stmt(env,'INSERT INTO nc_assurance_observations(id,customer_id,case_id,basis_hash,evidence_json,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',newId(),row.customer_id,row.id,proof.basis,canonical(proof),status,actorLabel(actor),at),
  ]
}

export async function recheckAssurance(env: Bindings, actor: Actor, input: Input) {
  investigator(actor)
  const seq=await sequence(env),id=input.text('case',{max:100}),row=await assuranceCase(env,actor,id)
  const proof=await current(env,actor,row)
  const status=!proof.mismatch && row.approved_basis===proof.basis?'resolved':'open'
  await commit(env,[unchanged(env,seq),ownerGuard(env,row.owner_id),...observationStatements(env,actor,row,proof)],
    {actor:actorLabel(actor),action:'assurance.recheck',subject:id,detail:{basis:proof.basis,mismatch:proof.mismatch,status}})
  return {id,status,evidence:proof}
}

// Bind a proposed financial fix to the current investigation and its assignee.
// Source-control cases accept ordinary amendment proposals; an over-billed seat case accepts an
// invoice credit against one of its own invoices. Catch-up charges bind through assuranceCharge.
export async function assuranceProposal(env: Bindings, actor: Actor, input: Input, kind: string, payload: Row) {
  if (!input.has('assurance_case')) return null
  investigator(actor)
  const row=await assuranceCase(env,actor,input.text('assurance_case',{max:100}))
  insist(row.status==='open','assurance_case_resolved',409)
  await activeOwner(env,row.owner_id)
  if(payload.invoice_refund===true) {
    insist(kind==='amendment' && row.kind==='usage_source_control','assurance_fix_kind_unsupported',409)
    const invoice=await one(env,'SELECT customer_id FROM nc_invoices WHERE id=?',payload.invoice)
    insist(invoice?.customer_id===row.customer_id,'assurance_fix_customer_mismatch',409)
  }
  if(row.kind===MOVE_KIND) {
    insist(kind==='amendment' && payload.setup!==true && payload.invoice_credit!==true,'assurance_fix_kind_unsupported',409)
    const proof=await current(env,actor,row)
    insist(proof.mismatch && proof.subscription===payload.subscription,'assurance_fix_source_mismatch',409)
    insist(proof.basis===row.basis_hash,'assurance_source_changed',409)
    return {case:row.id,owner:row.owner_id,proposer:actor.id,kind:actor.kind,moveBasis:proof.basis}
  }
  if(row.kind===RAMP_KIND) {
    insist(kind==='amendment' && payload.invoice_credit===true,'assurance_fix_kind_unsupported',409)
    const proof=await current(env,actor,row)
    const limit=proof.direction==='over_billed' && proof.billed.some((b:Row)=>b.invoice===payload.invoice) ? -proof.differenceCents : 0
    insist(limit>0,'assurance_fix_source_mismatch',409)
    insist(cents(String(payload.amount))<=limit,'assurance_fix_exceeds_difference',409)
    return {case:row.id,owner:row.owner_id,proposer:actor.id,kind:actor.kind}
  }
  insist(kind==='amendment' && payload.setup!==true && payload.invoice_credit!==true,'assurance_fix_kind_unsupported',409)
  const target=await one(env,'SELECT customer_id FROM nc_subscriptions WHERE id=?',payload.subscription)
  insist(target?.customer_id===row.customer_id,'assurance_fix_customer_mismatch',409)
  return {case:row.id,owner:row.owner_id,proposer:actor.id,kind:actor.kind}
}

// A member-prepared catch-up charge cites the open under-billed case it corrects. It bills only when a
// person later approves the invoice that consumes it, and the case stays open until a recheck agrees.
export async function assuranceCharge(env: Bindings, actor: Actor, input: Input, customer: string, subscription: string | null, amountCents: number) {
  if (!input.has('assurance_case')) return null
  const row=await assuranceCase(env,actor,input.text('assurance_case',{max:100}))
  insist(row.status==='open' && row.kind===RAMP_KIND,'assurance_fix_kind_unsupported',409)
  await activeOwner(env,row.owner_id)
  const proof=await current(env,actor,row)
  insist(proof.direction==='under_billed' && row.customer_id===customer && proof.subscription===subscription,'assurance_fix_source_mismatch',409)
  const pending=await one(env,"SELECT COALESCE(SUM(amount_cents),0) AS cents FROM nc_charges WHERE invoice_id IS NULL AND json_extract(pricing_evidence_json,'$.assuranceCase')=?",row.source_id)
  insist(amountCents+pending!.cents<=proof.differenceCents,'assurance_fix_exceeds_difference',409)
  return {evidence:{assuranceCase:row.source_id,assurance:{case:row.id,owner:row.owner_id,proposer:actor.id,kind:actor.kind}},
    guards:[guard(env,'assurance_case_changed',"EXISTS(SELECT 1 FROM nc_assurance_cases WHERE id=? AND status='open' AND owner_id=?)",row.id,row.owner_id)]}
}

// A person runs an ordinary governed door and names the open case it corrects. The case must still show
// the mismatch this execution addresses; the link is audited with the execution and never closes the case.
export async function assuranceExecution(env: Bindings, actor: Actor, input: Input, kind: string, covers: (proof: Row) => boolean) {
  if (!input.has('assurance_case')) return null
  const row=await assuranceCase(env,actor,input.text('assurance_case',{max:100}))
  insist(row.status==='open' && row.kind===kind,'assurance_fix_kind_unsupported',409)
  await activeOwner(env,row.owner_id)
  const proof=await current(env,actor,row)
  insist(proof.mismatch && covers(proof),'assurance_fix_source_mismatch',409)
  return {case:row.id,guards:[guard(env,'assurance_case_changed',"EXISTS(SELECT 1 FROM nc_assurance_cases WHERE id=? AND status='open' AND owner_id=?)",row.id,row.owner_id)]}
}

export async function assuranceProposalGuards(env: Bindings, link: Row | null) {
  if (!link) return []
  if (link.moveBasis) {
    const row=await one(env,'SELECT * FROM nc_assurance_cases WHERE id=?',link.case)
    insist(row,'assurance_case_not_found',404)
    const proof=(await moveInvestigationEvidence(env)).find(proof=>proof.source===row.source_id)
    insist(proof?.basis===link.moveBasis,'assurance_source_changed',409)
  }
  const checks: [string,string,unknown[]][] = [
    ['assurance_proposer_unavailable',link.kind==='member'
      ? "EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance'))"
      : "EXISTS(SELECT 1 FROM nc_agent_keys WHERE id=? AND revoked_at IS NULL AND instr(' '||scopes||' ',' prepare ')>0)",[link.proposer]],
    ['assurance_owner_unavailable',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance'))",[link.owner]],
    ['assurance_case_changed',"EXISTS(SELECT 1 FROM nc_assurance_cases a JOIN nc_customers c ON c.id=a.customer_id WHERE a.id=? AND a.owner_id=? AND a.status='open' AND c.erased_at IS NULL)",[link.case,link.owner]],
  ]
  const guards: D1PreparedStatement[]=[]
  for (const [code,condition,params] of checks) {
    // Explain the refusal now; repeat the check atomically with the adjustment.
    insist((await one(env,`SELECT (${condition}) AS allowed`,...params))?.allowed,code,409)
    guards.push(guard(env,code,condition,...params))
  }
  return guards
}

export async function investigateMove(env: Bindings, actor: Actor, input: Input) {
  investigator(actor)
  const owner=input.text('owner',{max:100})
  return await scanCases(env,actor,[],owner,'move-in',()=>moveInvestigationEvidence(env))
}
