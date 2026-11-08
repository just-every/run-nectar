// Test-mode remit-to evidence only. This door grants no collection authority.
import type { Bindings } from '../auth.server'
import { actorLabel, requireOwner, type Actor } from './actor'
import { clockInstant } from './clock'
import { all, canonical, commit, fingerprint, guard, insist, newId, one, parseJson, stmt, type Row } from './core'
import { setupOwner, setupOwnerFence } from './hosted-setup-basis'
import type { Input } from './input'
import { providerReference, providerUnavailable, stripeForAccount } from './payments/stripe'

export interface TransferInstructions {
  bankName: string; accountHolderName: string; accountNumber: string; routingNumber: string
  accountType: 'checking' | 'savings'; networks: ('ach' | 'domestic_wire_us')[]
  currency: 'USD'; country: 'US'; testMode: true
}
interface Basis {
  customer: string; customerRevision: string; binding: string; bindingRevision: string
  accountRef: string; customerRef: string; currency: 'USD'; testMode: true
}
const invalid = 'transfer_instruction_evidence_invalid'
function text(value: unknown) {
  insist(typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 160
    && !/[\u0000-\u001f\u007f]/.test(value), invalid, 409)
  return value
}
function validateInstructions(row: Row): TransferInstructions {
  insist(row.object === 'funding_instructions' && row.funding_type === 'bank_transfer' && row.currency === 'usd'
    && row.livemode === false && row.bank_transfer?.type === 'us_bank_transfer' && row.bank_transfer.country === 'US', invalid, 409)
  const addresses = row.bank_transfer.financial_addresses
  insist(Array.isArray(addresses) && addresses.length === 1 && addresses[0]?.type === 'aba', invalid, 409)
  const address = addresses[0], aba = address.aba
  insist(aba && typeof aba.account_number === 'string' && /^\d{4,17}$/.test(aba.account_number)
    && typeof aba.routing_number === 'string' && /^\d{9}$/.test(aba.routing_number)
    && ['checking','savings'].includes(aba.account_type)
    && Array.isArray(address.supported_networks) && address.supported_networks.length > 0
    && address.supported_networks.every((network: unknown) => ['ach','domestic_wire_us'].includes(String(network)))
    && new Set(address.supported_networks).size === address.supported_networks.length, invalid, 409)
  return { bankName: text(aba.bank_name), accountHolderName: text(aba.account_holder_name), accountNumber: aba.account_number,
    routingNumber: aba.routing_number, accountType: aba.account_type, networks: [...address.supported_networks].sort(),
    currency: 'USD', country: 'US', testMode: true }
}

async function source(env: Bindings, customer: string, account: string): Promise<Basis> {
  const row = await one(env, `SELECT c.revision AS customer_revision,c.currency,c.billing_entity_id,b.* FROM nc_customers c
    JOIN nc_stripe_customer_bindings b ON b.customer_id=c.id WHERE c.id=? AND b.account_ref=? AND c.erased_at IS NULL AND c.status='active'
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (c.id,b.id))`, customer, account)
  insist(row && row.currency === 'USD', 'transfer_instruction_binding_required', 409)
  if (row.billing_entity_id) insist(await one(env, 'SELECT 1 FROM nc_billing_entities WHERE id=? AND processor_account_ref=?', row.billing_entity_id, account), 'stripe_frozen_account_mismatch', 409)
  return { customer, customerRevision: row.customer_revision, binding: row.id, bindingRevision: row.revision,
    accountRef: account, customerRef: row.stripe_customer_ref, currency: 'USD', testMode: true }
}
function sourceFence(env: Bindings, basis: Basis) {
  return guard(env, 'transfer_instruction_binding_changed', `EXISTS(SELECT 1 FROM nc_stripe_customer_bindings b JOIN nc_customers c ON c.id=b.customer_id
    WHERE b.id=? AND b.revision=? AND b.account_ref=? AND b.stripe_customer_ref=? AND c.id=? AND c.revision=? AND c.currency='USD'
    AND c.erased_at IS NULL AND c.status='active' AND (c.billing_entity_id IS NULL OR EXISTS(SELECT 1 FROM nc_billing_entities e WHERE e.id=c.billing_entity_id AND e.processor_account_ref=b.account_ref)))
    AND NOT EXISTS(SELECT 1 FROM nc_erased_records WHERE record_id IN (?,?))`, basis.binding,basis.bindingRevision,basis.accountRef,basis.customerRef,basis.customer,basis.customerRevision,basis.customer,basis.binding)
}
async function providerSource(env: Bindings, basis: Basis) {
  const selected = await stripeForAccount(env,basis.accountRef).catch(providerUnavailable)
  const customer = await selected.stripe(`/customers/${encodeURIComponent(basis.customerRef)}`).catch(providerUnavailable)
  const cash = await selected.stripe(`/customers/${encodeURIComponent(basis.customerRef)}/cash_balance`).catch(providerUnavailable)
  insist(customer.object === 'customer' && customer.id === basis.customerRef && customer.deleted !== true && customer.livemode === false
    && cash.object === 'cash_balance' && providerReference(cash.customer) === basis.customerRef && cash.livemode === false
    && cash.settings?.reconciliation_mode === 'manual', 'transfer_instruction_test_manual_required', 409)
  return selected
}
function view(row: Row) {
  return { id: row.id, customer: row.customer_id, status: row.status, accountRef: row.account_ref,
    instructions: row.status === 'available' ? parseJson<TransferInstructions | null>(row.fields_json,null) : null }
}
export async function prepareTransferInstructions(env: Bindings, actor: Actor, input: Input) {
  const factor = await setupOwner(env,actor)
  input.only(['customer','account_ref','returnTo'])
  const basis = await source(env,input.text('customer',{max:100}),providerReference(input.text('account_ref',{max:255})))
  insist(!await one(env,'SELECT 1 FROM nc_transfer_instructions WHERE binding_id=?',basis.binding),'transfer_instruction_already_claimed',409)
  await providerSource(env,basis)
  const id = newId(), hash = await fingerprint(basis)
  await commit(env,[...setupOwnerFence(env,actor),sourceFence(env,basis),
    stmt(env,`INSERT INTO nc_transfer_instruction_preparations(id,customer_id,basis_json,basis_hash,prepared_by,session_id,factor_reference,prepared_at)
      VALUES(?,?,?,?,?,?,?,?)`,id,basis.customer,canonical(basis),hash,actor.id,actor.sessionId,factor.reference,clockInstant(env))],
  {actor:actorLabel(actor),action:'transfer.instructions.prepare',subject:basis.customer,detail:{request:id,basisHash:hash}})
  return { id, review: basis, confirm: { request:id,basis_hash:hash,customer:basis.customer,account_ref:basis.accountRef,
    stripe_customer_ref:basis.customerRef,binding_revision:basis.bindingRevision,currency:'USD',test_mode:true,confirm:true } }
}
export async function confirmTransferInstructions(env: Bindings, actor: Actor, input: Input) {
  const factor = await setupOwner(env,actor)
  input.only(['request','basis_hash','customer','account_ref','stripe_customer_ref','binding_revision','currency','test_mode','confirm','returnTo'])
  insist(input.flag('confirm'),'transfer_instruction_confirmation_required')
  const prepared = await one(env,'SELECT * FROM nc_transfer_instruction_preparations WHERE id=?',input.text('request',{max:100}))
  insist(prepared && prepared.prepared_by === actor.id && prepared.session_id === actor.sessionId && prepared.factor_reference === factor.reference,
    'transfer_instruction_preparation_unavailable',409)
  const basis = await source(env,input.text('customer',{max:100}),providerReference(input.text('account_ref',{max:255})))
  insist(prepared.basis_json === canonical(basis) && prepared.basis_hash === input.text('basis_hash',{max:100})
    && basis.customerRef === input.text('stripe_customer_ref',{max:255}) && basis.bindingRevision === input.text('binding_revision',{max:100})
    && input.text('currency',{max:3}) === 'USD' && input.flag('test_mode'), 'transfer_instruction_basis_changed',409)
  const selected = await providerSource(env,basis), id = newId(), at = clockInstant(env)
  await commit(env,[...setupOwnerFence(env,actor),sourceFence(env,basis),
    guard(env,'transfer_instruction_already_claimed','NOT EXISTS(SELECT 1 FROM nc_transfer_instructions WHERE binding_id=?)',basis.binding),
    guard(env,'transfer_instruction_preparation_unavailable','EXISTS(SELECT 1 FROM nc_transfer_instruction_preparations WHERE id=? AND session_id=? AND factor_reference=?)',prepared.id,actor.sessionId,factor.reference),
    stmt(env,`INSERT INTO nc_transfer_instructions(id,customer_id,binding_id,binding_revision,account_ref,stripe_customer_ref,status,claimed_at,fields_json)
      VALUES(?,?,?,?,?,?,'claimed',?,'{}')`,id,basis.customer,basis.binding,basis.bindingRevision,basis.accountRef,basis.customerRef,at)],
  {actor:actorLabel(actor),action:'transfer.instructions.claim',subject:basis.customer,detail:{request:prepared.id,instruction:id,basisHash:prepared.basis_hash}})
  try {
    // Nothing can reuse the durable claim, even if authority, reads or POST fail.
    await setupOwner(env,actor)
    insist(canonical(await source(env,basis.customer,basis.accountRef)) === canonical(basis),'transfer_instruction_binding_changed',409)
    await providerSource(env,basis)
    await setupOwner(env,actor)
    insist(canonical(await source(env,basis.customer,basis.accountRef)) === canonical(basis),'transfer_instruction_binding_changed',409)
    const result = await selected.stripe(`/customers/${encodeURIComponent(basis.customerRef)}/funding_instructions`,
      new URLSearchParams({funding_type:'bank_transfer',currency:'usd','bank_transfer[type]':'us_bank_transfer'}),`nectar-transfer-instructions-${id}`)
    const fields = validateInstructions(result), sourceHash = await fingerprint({account:basis.accountRef,customer:basis.customerRef,fields})
    await commit(env,[...setupOwnerFence(env,actor),sourceFence(env,basis),
      guard(env,'transfer_instruction_already_claimed',"EXISTS(SELECT 1 FROM nc_transfer_instructions WHERE id=? AND status='claimed')",id),
      stmt(env,"UPDATE nc_transfer_instructions SET status='available',fields_json=?,source_hash=?,completed_at=? WHERE id=?",canonical(fields),sourceHash,clockInstant(env),id)],
    {actor:actorLabel(actor),action:'transfer.instructions.retain',subject:basis.customer,detail:{instruction:id,sourceHash}})
  } catch {
    // A failed retention audit also leaves the already committed claim closed.
    await commit(env,[stmt(env,"UPDATE nc_transfer_instructions SET status='uncertain' WHERE id=? AND status='claimed'",id)],
      {actor:actorLabel(actor),action:'transfer.instructions.uncertain',subject:basis.customer,detail:{instruction:id}})
  }
  return view((await one(env,'SELECT * FROM nc_transfer_instructions WHERE id=?',id))!)
}
export async function readTransferInstructions(env: Bindings, actor: Actor, customer: string) {
  requireOwner(actor)
  return {instructions:(await all(env,'SELECT * FROM nc_transfer_instructions WHERE customer_id=? ORDER BY claimed_at,id',customer)).map(view)}
}

/** Called only during ordinary native issue, in the invoice's atomic batch. */
export async function transferInstructionIssue(env: Bindings, invoice: Row, route: string) {
  const account = parseJson<Row>(route,{}).processorAccountRef
  const rows = await all(env,`SELECT t.* FROM nc_transfer_instructions t JOIN nc_stripe_customer_bindings b ON b.id=t.binding_id
    JOIN nc_customers c ON c.id=t.customer_id WHERE t.customer_id=? AND t.status='available' AND b.revision=t.binding_revision
    AND b.account_ref=t.account_ref AND b.stripe_customer_ref=t.stripe_customer_ref AND c.status='active' AND c.erased_at IS NULL
    AND (? IS NULL OR t.account_ref=?)`,invoice.customer_id,account??null,account??null)
  if(invoice.currency !== 'USD' || rows.length !== 1) return []
  const row = rows[0], snapshot = canonical({instructionId:row.id,sourceHash:row.source_hash,accountRef:row.account_ref,fields:parseJson(row.fields_json,{})})
  return [guard(env,'transfer_instruction_binding_changed',`EXISTS(SELECT 1 FROM nc_transfer_instructions t JOIN nc_stripe_customer_bindings b ON b.id=t.binding_id
    WHERE t.id=? AND t.status='available' AND t.fields_json=? AND b.revision=t.binding_revision AND b.account_ref=t.account_ref AND b.stripe_customer_ref=t.stripe_customer_ref)`,row.id,row.fields_json),
    stmt(env,'UPDATE nc_invoices SET transfer_instructions_json=? WHERE id=?',snapshot,invoice.id)]
}
export function customerTransferInstructions(snapshot: string | null): TransferInstructions | null {
  const saved = parseJson<Row>(snapshot,{}), fields = saved.fields
  if(!fields || fields.testMode !== true || fields.currency !== 'USD' || fields.country !== 'US')return null
  // A closed customer projection excludes provider identity and internal custody.
  return {bankName:fields.bankName,accountHolderName:fields.accountHolderName,accountNumber:fields.accountNumber,routingNumber:fields.routingNumber,
    accountType:fields.accountType,networks:fields.networks,currency:'USD',country:'US',testMode:true}
}
