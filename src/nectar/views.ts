import { erasureRequests } from './erasure-requests'
import { cadenceReport } from './cadence-actions'
import { retentionReport } from './retention-offers'
import { reportSchedule,reportDelivery } from './report-schedules'
import { setupSourceDownload } from './setup-download'
// Read models served at GET /api/nectar/... Every view checks the actor's
// capability itself and applies the same rules as the pages that render it.
import type { Bindings } from '../auth.server'
import { agentKeys, members } from './access'
import { requireCapability, type Actor } from './actor'
import { runDetail, runs } from './billruns'
import { businessView } from './business'
import { certificates } from './certificates'
import { catalog } from './catalog'
import { ageing, notices, tasks } from './collections'
import { NectarError, all, one, type Row } from './core'
import { customers, requireCustomer } from './customers'
import { API_DOORS, match } from './doors'
import { entitlements, explainEntitlement } from './exports'
import { importJobs, shadowSubscriptions } from './movein/stripe'
import { policyChanges, policySettings } from './policy-changes'
import { proposalDetail, proposals } from './proposals'
import { customerLedger, payments } from './receivables'
import { lifecycleHistory, lifecycleIntervals } from './lifecycle-records'
import { subscriptionDetail } from './subscriptions'
import { batches, inspect } from './usage'
import { report, reportInvoice } from './reports'
import { upcoming } from './upcoming'
import { invoiceList } from './invoice-list'
import { invoiceView } from './invoice-expansions'
import { notes, noteMembers } from './notes'
import { notifications } from './notifications'
import { metadataView,metadataFor,withMetadata } from './metadata'
import { metadataObjects } from './metadata-lists'
import { customerNotes } from './note-records'
import { reportLine } from './report-lines'

type View = (env: Bindings, actor: Actor, request: Request, id: string, url: URL) => Promise<unknown>

export async function audit(env: Bindings, actor: Actor) {
  requireCapability(actor, 'export')
  return await all(env, 'SELECT seq, at, actor, action, subject, detail FROM nc_audit ORDER BY seq DESC LIMIT 500')
}

export async function customerView(env: Bindings, actor: Actor, id: string): Promise<Row> {
  requireCapability(actor, 'read')
  const customer = await requireCustomer(env, id)
  if(customer.erased_at) return {...customer,contacts:[],subscriptions:[],ledger:await customerLedger(env,actor,id),entitlements:[],incumbentInvoices:[],charges:[],certificates:[],exemptionClaims:[],certificateReminders:[],notes:[],metadata:{}}
  const [contacts, subscriptions, ledger, features, incumbent] = await Promise.all([
    all(env, 'SELECT * FROM nc_contacts WHERE customer_id = ? ORDER BY created_at', id),
    all(env, "SELECT s.*, (SELECT COUNT(*) FROM nc_items i WHERE i.subscription_id = s.id) AS items FROM nc_subscriptions s WHERE s.customer_id = ? ORDER BY s.created_at", id),
    customerLedger(env, actor, id),
    entitlements(env, actor, id),
    all(env, 'SELECT provider_ref, number, status, period_start, period_end, total_cents, paid_cents, remaining_cents FROM nc_incumbent_invoices WHERE customer_id = ? ORDER BY period_start DESC', id),
  ])
  return { ...customer,...await metadataFor(env,'customer',id), notes: await customerNotes(env, id), contacts, subscriptions:await withMetadata(env,'subscription',await Promise.all(subscriptions.map(async s=>({...s,intervals:lifecycleIntervals(await lifecycleHistory(env,s.id))})))), ledger, entitlements: features, incumbentInvoices: incumbent, charges: await all(env, 'SELECT * FROM nc_charges WHERE customer_id=? ORDER BY effective_date,id', id), certificatePolicy: await one(env, 'SELECT enabled,revision FROM nc_certificate_policy WHERE singleton=1'), certificates: await certificates(env, actor, id), exemptionClaims: await all(env, 'SELECT state FROM nc_exemption_claims WHERE customer_id=? ORDER BY state', id), certificateReminders: await all(env, 'SELECT state,kind,status,created_at FROM nc_certificate_reminders WHERE customer_id=? ORDER BY created_at DESC', id) }
}

export const views: Record<string, View> = {
  erasures:(env,actor)=>erasureRequests(env,actor),
  cadences:(env,actor)=>cadenceReport(env,actor),
  retention:(env,actor)=>retentionReport(env,actor),
  reportSchedule:(env,actor)=>reportSchedule(env,actor),
  reportDelivery:(env,actor,_r,id)=>reportDelivery(env,actor,id),
  setupSource:(env,actor,_r,id)=>setupSourceDownload(env,actor,id),
  notifications: (env,actor) => notifications(env,actor),
  metadata: (env,actor,_r,id) => {const [kind,record]=id.split('/');return metadataView(env,actor,kind,record)},
  metadataObjects: (env,actor,_r,id,url) => metadataObjects(env,actor,id,url),
  notes: (env, actor, _r, id) => { const [kind,record] = id.split('/'); return notes(env,actor,kind,record) },
  noteMembers: (env,actor) => noteMembers(env,actor),
  me: async (_env, actor) => ({ id: actor.id, kind: actor.kind, name: actor.name, email: actor.email, role: actor.role, capabilities: [...actor.capabilities] }),
  business: (env, actor) => businessView(env, actor),
  customers: (env, actor,_r,_id,url) => customers(env, actor,url),
  customer: (env, actor, _request, id) => customerView(env, actor, id),
  catalog: (env, actor,_r,_id,url) => catalog(env, actor,url),
  upcoming: (env, actor, _r, id, url) => upcoming(env,actor,id,url.searchParams.get('period')),
  subscription: (env, actor, _request, id) => subscriptionDetail(env, actor, id),
  batches: (env, actor) => batches(env, actor),
  inspect: (env, actor, _request, _id, url) => inspect(env, actor, url.searchParams.get('period') ?? ''),
  runs: (env, actor) => runs(env, actor),
  run: (env, actor, _request, id) => runDetail(env, actor, id),
  invoices: (env, actor, _r, _id, url) => invoiceList(env,actor,url),
  invoice: (env, actor, _request, id, url) => invoiceView(env, actor, id, url),
  ageing: (env, actor) => ageing(env, actor),
  payments: (env, actor,_r,_id,url) => payments(env, actor,undefined,url),
  notices: (env, actor) => notices(env, actor),
  tasks: (env, actor) => tasks(env, actor),
  policySettings: (env, actor) => policySettings(env, actor),
  policies: (env, actor) => policyChanges(env, actor),
  proposals: (env, actor) => proposals(env, actor),
  proposal: (env, actor, _request, id) => proposalDetail(env, actor, id),
  entitlement: (env, actor, _request, id, url) => url.searchParams.get('feature') ? explainEntitlement(env, actor, id, url.searchParams.get('feature')!, url.searchParams.get('date') ?? undefined) : entitlements(env, actor, id),
  imports: (env, actor) => importJobs(env, actor),
  shadow: (env, actor) => shadowSubscriptions(env, actor),
  members: (env, actor) => members(env, actor),
  credentials: (env, actor) => agentKeys(env, actor),
  audit: (env, actor) => audit(env, actor),
  report: (env, actor, _r, id, url) => report(env, actor, id, url),
  reportInvoice: (env, actor, _r, id, url) => { const [metric, invoice] = id.split('/'); return reportInvoice(env, actor, metric, invoice, url) },
  reportLine: (env, actor, _r, id) => { const [invoice, , line] = id.split('/'); return reportLine(env, actor, invoice, line) },
}

export function route(path: string): { view: View; id: string } {
  const found = match(API_DOORS, path)
  if (!found) throw new NectarError('not_found', 404)
  return { view: views[found.name], id: found.id }
}
