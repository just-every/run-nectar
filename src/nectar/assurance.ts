// Current assurance coverage: recorded source controls versus ingested usage.
// A scan owns only case records. Financial fixes keep their existing approvals.
import type { Bindings } from '../auth.server'
import { actorLabel, requireCapability, requireMember, type Actor } from './actor'
import { all, canonical, commit, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { isMonth } from './dates'
import type { Input } from './input'
import { controlTotals } from './reconciliation'

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

async function current(env: Bindings, actor: Actor, row: Row) {
  insist(!await one(env,'SELECT 1 FROM nc_customers WHERE id=? AND erased_at IS NOT NULL',row.customer_id),'assurance_case_not_found',404)
  const control=await one(env,'SELECT day FROM nc_usage_controls WHERE id=?',row.source_id)
  insist(control,'assurance_source_unavailable',409)
  const compared=(await controlTotals(env,actor,control.day.slice(0,7))).find(c=>c.id===row.source_id)
  insist(compared,'assurance_source_unavailable',409)
  return evidence(compared)
}

const project = (row: Row): Row => ({...row,evidence:parseJson(row.evidence_json,{}),evidence_json:undefined})

export async function assuranceCases(env: Bindings, actor: Actor) {
  requireCapability(actor,'read')
  return await all(env,'SELECT a.* FROM nc_assurance_cases a JOIN nc_customers c ON c.id=a.customer_id WHERE c.erased_at IS NULL ORDER BY a.created_at,a.id').then(rows=>rows.map(project))
}

export async function assuranceCase(env: Bindings, actor: Actor, id: string): Promise<Row> {
  requireCapability(actor,'read')
  const row=await one(env,'SELECT a.* FROM nc_assurance_cases a JOIN nc_customers c ON c.id=a.customer_id WHERE a.id=? AND c.erased_at IS NULL',id)
  insist(row,'assurance_case_not_found',404)
  return {...project(row),observations:(await all(env,'SELECT * FROM nc_assurance_observations WHERE case_id=? ORDER BY created_at,id',id)).map(project)}
}

export async function scanAssurance(env: Bindings, actor: Actor, input: Input) {
  investigator(actor)
  const period=input.text('period',{max:7}),owner=input.text('owner',{max:100})
  insist(isMonth(period),'invalid_period')
  await activeOwner(env,owner)
  const seq=await sequence(env), controls=await controlTotals(env,actor,period)
  const statements:D1PreparedStatement[]=[unchanged(env,seq),ownerGuard(env,owner)]
  const opened:string[]=[],rechecked:string[]=[]
  for(const row of controls) {
    // An erased customer's source controls are retained financial facts only.
    if(await one(env,'SELECT 1 FROM nc_customers WHERE id=? AND erased_at IS NOT NULL',row.customer))continue
    const existing=await one(env,'SELECT * FROM nc_assurance_cases WHERE source_id=?',row.id)
    const proof=evidence(row)
    if(existing) {
      const status=!proof.mismatch && existing.approved_basis===proof.basis?'resolved':'open'
      if(existing.basis_hash!==proof.basis || existing.status!==status) {
        statements.push(ownerGuard(env,existing.owner_id),...observationStatements(env,actor,existing,proof))
        rechecked.push(existing.id)
      }
      continue
    }
    if(!row.mismatch)continue
    const id=newId(),at=now()
    opened.push(id)
    statements.push(stmt(env,"INSERT INTO nc_assurance_cases(id,customer_id,source_id,owner_id,status,basis_hash,evidence_json,created_at,checked_at) VALUES(?,?,?,?,'open',?,?,?,?)",id,row.customer,row.id,owner,row.basis,canonical(proof),at,at),
      stmt(env,"INSERT INTO nc_assurance_observations(id,customer_id,case_id,basis_hash,evidence_json,status,created_by,created_at) VALUES(?,?,?,?,?,'open',?,?)",newId(),row.customer,id,row.basis,canonical(proof),actorLabel(actor),at))
  }
  await commit(env,statements,{actor:actorLabel(actor),action:'assurance.scan',subject:period,detail:{coverage:'usage_source_control',compared:controls.length,opened,rechecked}})
  return {coverage:['usage_source_control'],compared:controls.length,opened,rechecked}
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
// This door currently supports ordinary amendment and issued-credit proposals.
export async function assuranceProposal(env: Bindings, actor: Actor, input: Input, kind: string, payload: Row) {
  if (!input.has('assurance_case')) return null
  investigator(actor)
  insist(kind==='amendment' && payload.setup!==true,'assurance_fix_kind_unsupported',409)
  const row=await assuranceCase(env,actor,input.text('assurance_case',{max:100}))
  insist(row.status==='open','assurance_case_resolved',409)
  await activeOwner(env,row.owner_id)
  const target=payload.invoice_credit===true
    ? await one(env,'SELECT customer_id FROM nc_invoices WHERE id=?',payload.invoice)
    : await one(env,'SELECT customer_id FROM nc_subscriptions WHERE id=?',payload.subscription)
  insist(target?.customer_id===row.customer_id,'assurance_fix_customer_mismatch',409)
  return {case:row.id,owner:row.owner_id,proposer:actor.id,kind:actor.kind}
}

export function assuranceProposalGuards(env: Bindings, link: Row | null) {
  if (!link) return []
  const authority=link.kind==='member'
    ? guard(env,'assurance_proposer_unavailable',"EXISTS(SELECT 1 FROM nc_members WHERE id=? AND status='active' AND role IN ('owner','finance'))",link.proposer)
    : guard(env,'assurance_proposer_unavailable',"EXISTS(SELECT 1 FROM nc_agent_keys WHERE id=? AND revoked_at IS NULL AND instr(' '||scopes||' ',' prepare ')>0)",link.proposer)
  return [authority,ownerGuard(env,link.owner),guard(env,'assurance_case_changed',"EXISTS(SELECT 1 FROM nc_assurance_cases a JOIN nc_customers c ON c.id=a.customer_id WHERE a.id=? AND a.owner_id=? AND a.status='open' AND c.erased_at IS NULL)",link.case,link.owner)]
}
