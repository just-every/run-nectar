// Read models served at GET /api/nectar/... Every view checks the actor's
// capability itself and applies the same rules as the pages that render it.
import type { Bindings } from '../auth.server'
import { agentKeys, members } from './access'
import { requireCapability, type Actor } from './actor'
import { invoiceDetail, runDetail, runs } from './billruns'
import { businessView } from './business'
import { certificates } from './certificates'
import { catalog } from './catalog'
import { ageing, notices, tasks } from './collections'
import { NectarError, all, one, type Row } from './core'
import { customers, requireCustomer } from './customers'
import { API_DOORS, match } from './doors'
import { entitlements, explainEntitlement } from './exports'
import { importJobs, shadowSubscriptions } from './movein/stripe'
import { proposalDetail, proposals } from './proposals'
import { customerLedger, payments } from './receivables'
import { subscriptionDetail } from './subscriptions'
import { batches, inspect } from './usage'

type View = (env: Bindings, actor: Actor, request: Request, id: string, url: URL) => Promise<unknown>

export async function audit(env: Bindings, actor: Actor) {
  requireCapability(actor, 'export')
  return await all(env, 'SELECT seq, at, actor, action, subject, detail FROM nc_audit ORDER BY seq DESC LIMIT 500')
}

export async function customerView(env: Bindings, actor: Actor, id: string): Promise<Row> {
  requireCapability(actor, 'read')
  const customer = await requireCustomer(env, id)
  const [contacts, subscriptions, ledger, features, incumbent] = await Promise.all([
    all(env, 'SELECT * FROM nc_contacts WHERE customer_id = ? ORDER BY created_at', id),
    all(env, "SELECT s.*, (SELECT COUNT(*) FROM nc_items i WHERE i.subscription_id = s.id) AS items FROM nc_subscriptions s WHERE s.customer_id = ? ORDER BY s.created_at", id),
    customerLedger(env, actor, id),
    entitlements(env, actor, id),
    all(env, 'SELECT provider_ref, number, status, period_start, period_end, total_cents, paid_cents, remaining_cents FROM nc_incumbent_invoices WHERE customer_id = ? ORDER BY period_start DESC', id),
  ])
  return { ...customer, contacts, subscriptions, ledger, entitlements: features, incumbentInvoices: incumbent, charges: await all(env, 'SELECT * FROM nc_charges WHERE customer_id=? ORDER BY effective_date,id', id), certificatePolicy: await one(env, 'SELECT enabled,revision FROM nc_certificate_policy WHERE singleton=1'), certificates: await certificates(env, actor, id), exemptionClaims: await all(env, 'SELECT state FROM nc_exemption_claims WHERE customer_id=? ORDER BY state', id), certificateReminders: await all(env, 'SELECT state,kind,status,created_at FROM nc_certificate_reminders WHERE customer_id=? ORDER BY created_at DESC', id) }
}

export const views: Record<string, View> = {
  me: async (_env, actor) => ({ id: actor.id, kind: actor.kind, name: actor.name, email: actor.email, role: actor.role, capabilities: [...actor.capabilities] }),
  business: (env, actor) => businessView(env, actor),
  customers: (env, actor) => customers(env, actor),
  customer: (env, actor, _request, id) => customerView(env, actor, id),
  catalog: (env, actor) => catalog(env, actor),
  subscription: (env, actor, _request, id) => subscriptionDetail(env, actor, id),
  batches: (env, actor) => batches(env, actor),
  inspect: (env, actor, _request, _id, url) => inspect(env, actor, url.searchParams.get('period') ?? ''),
  runs: (env, actor) => runs(env, actor),
  run: (env, actor, _request, id) => runDetail(env, actor, id),
  invoice: (env, actor, _request, id) => invoiceDetail(env, actor, id),
  ageing: (env, actor) => ageing(env, actor),
  payments: (env, actor) => payments(env, actor),
  notices: (env, actor) => notices(env, actor),
  tasks: (env, actor) => tasks(env, actor),
  proposals: (env, actor) => proposals(env, actor),
  proposal: (env, actor, _request, id) => proposalDetail(env, actor, id),
  entitlement: (env, actor, _request, id, url) => url.searchParams.get('feature') ? explainEntitlement(env, actor, id, url.searchParams.get('feature')!, url.searchParams.get('date') ?? undefined) : entitlements(env, actor, id),
  imports: (env, actor) => importJobs(env, actor),
  shadow: (env, actor) => shadowSubscriptions(env, actor),
  members: (env, actor) => members(env, actor),
  credentials: (env, actor) => agentKeys(env, actor),
  audit: (env, actor) => audit(env, actor),
}

export function route(path: string): { view: View; id: string } {
  const found = match(API_DOORS, path)
  if (!found) throw new NectarError('not_found', 404)
  return { view: views[found.name], id: found.id }
}
