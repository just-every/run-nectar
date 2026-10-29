import { redactShared,redactSnapshotCsv } from './erasure-snapshots'
// Inventory actual rows and fence their exact images before privacy writes.
// Only opaque relationships, typed financial facts and dates survive on a
// customer's rows. Free text, arbitrary JSON and file bytes do not.
import type { Bindings } from '../auth.server'
import { all, type Row } from './core'
import type { D1Sql } from '../modules/import-kit/src/d1/index'
import { erasureMutationStatements, type ErasureMutation } from './erasure-sql'

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const relation = new Set(['customer_id','subscription_id','invoice_id','payment_id','proposal_id','credit_id','record_id','subject','related_id','term_id','offer_id','contract_id','note_id','correction_id','original_invoice_id'])
const keep = new Set(['purpose','correction_kind','intent_key','billing_key','interval_unit','billing_timing','numbering_mode','capture_kind','account_ref','custody','basis_hash','error_code','occurred_text','number','kind','document_kind','status','origin','language','currency','method','method_kind','billing_mode','invoice_kind','calc_version','version','revision','quantity','unit_amount','value','tax_rate','tax_mode','tax_jurisdiction','anchor_day','billing_interval','access','scope','scopes','pricing_model','action','state','approval_mode','mail_status','verified_method','event','created_by_kind','prepared_by_kind','requested_by_kind','source','proposal_kind'])
// The processor refund identifier is retained cash custody under ct batch11 I.
const typedPlanField=(table:string,column:string)=>table.startsWith('nc_processor_')&&['type','event_type','code','decline_code','source_hash'].includes(column)||table==='nc_plan_changes'&&['mode','policy'].includes(column)||table==='nc_invoice_refunds'&&column==='destination'
const financialIdentifier=(table:string,column:string)=>(table==='nc_remittances'&&['source_key_hash','payload_hash','confirmation_hash'].includes(column))||(['nc_prepaid_refunds','nc_invoice_refunds'].includes(table)&&column==='refund_ref')||(table.startsWith('nc_processor_')&&['transaction_ref','source_ref','payout_ref','event_ref','object_ref','intent_ref','transfer_ref','stripe_customer_ref','payment_intent_ref','charge_ref','refund_ref'].includes(column))
const reserved = new Set(['nc_remittance_source_keys','nc_incumbent_revenue','nc_erased_records','nc_guard','nc_privacy_generation','nc_privacy_context','nc_erasure_requests','nc_erasure_financial','nc_business','nc_members','nc_agent_keys'])
const keyed = (value: unknown, ids: Set<string>): boolean => typeof value === 'string' ? ids.has(value) : Array.isArray(value) ? value.some(v => keyed(v, ids)) : !!value && typeof value === 'object' && Object.values(value).some(v => keyed(v, ids))
const json = (text: unknown) => { try { return JSON.parse(String(text)) } catch { return null } }
const blankJson = (value: string) => Array.isArray(json(value)) ? '[]' : '{}'
interface Image { table: string; row: Row; key: Row; required: Set<string>; foreignKeys: Set<string>; scoped: boolean }
export interface ErasurePlan { generation:number; personalValues:string[]; statements: D1Sql[]; changes: { kind: string; fields: string[]; records: number }[]; ids: string[] }
export async function erasurePlan(env: Bindings, customer: Row): Promise<ErasurePlan> {
  const generation = Number((await all(env,'SELECT value FROM nc_privacy_generation WHERE id=1'))[0].value)
  const tables = await all(env, `SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'nc_*' ORDER BY name`)
  const images: Image[] = [], ids = new Set<string>([customer.id,...(await all(env,'SELECT id FROM nc_erasure_requests WHERE customer_id=?',customer.id)).map(r=>r.id)])
  for (const { name } of tables) {
    if (reserved.has(name)) continue
    const columns = await all(env, `PRAGMA table_info(${quote(name)})`)
    const foreignKeys = new Set<string>((await all(env, `PRAGMA foreign_key_list(${quote(name)})`)).map(key => key.from))
    const keys = columns.filter(c => c.pk).sort((a,b) => a.pk-b.pk).map(c => c.name)
    for (const row of await all(env, `SELECT * FROM ${quote(name)}`)) images.push({ table: name, row, key: Object.fromEntries(keys.map(k => [k,row[k]])), required: new Set(columns.filter(c=>c.notnull).map(c=>c.name)), foreignKeys, scoped: name === 'nc_customers' && row.id === customer.id })
  }
  // Discover record relationships to a fixed point, including proposal payloads
  // which name their customer rather than having a foreign-key column.
  for (let changed = true; changed;) {
    changed = false
    for (const image of images) {
      if (image.table === 'nc_audit' || image.table === 'nc_bill_runs' || image.table === 'nc_report_deliveries') continue
      const owns = image.scoped || (image.table==='nc_remittances' && keyed(json(image.row.source_json),new Set([...ids,customer.external_id,customer.provider_ref,customer.billing_email].filter(Boolean)))) || Object.entries(image.row).some(([k,v]) => relation.has(k) && typeof v === 'string' && ids.has(v)) || (image.table === 'nc_proposals' && keyed(json(image.row.payload_json),ids))
      if (!owns) continue
      if (!image.scoped) { image.scoped = true; changed = true }
      if (image.row.id && !ids.has(image.row.id)) { ids.add(image.row.id); changed = true }
    }
  }
  const memberIds=new Map((await all(env,'SELECT id,email FROM nc_members')).map(r=>[r.email,r.id]))
  const privateText=images.filter(i=>i.scoped).flatMap(({table,row,key,foreignKeys})=>Object.entries(row).filter(([column,value])=>typeof value==='string' && value.length && !memberIds.has(value) && !/(?:_by|_by_kind)$/.test(column) && column!=='prepared_name' && !(column in key) && !foreignKeys.has(column) && !column.endsWith('_json') && column!=='detail' && !(column.endsWith('_id') && !['external_id','event_id'].includes(column)) && !keep.has(column) && !financialIdentifier(table,column) && !typedPlanField(table,column) && !/(?:_at|_on|_date|_from|_to|_start|_end)$/.test(column)).map(([,value])=>value))
  const personal = [...new Set([...privateText,customer.name,customer.billing_email,customer.address,customer.external_id,customer.provider_ref,customer.tax_exempt_ref, ...images.filter(i=>i.scoped && i.table==='nc_contacts').flatMap(i=>[i.row.name,i.row.email])].filter(v=>typeof v==='string' && v.length))]
  const mutations: ErasureMutation[] = [], changes = new Map<string,{kind:string;fields:Set<string>;records:number}>()
  for (const image of images) {
    const { table,row,key,required,foreignKeys } = image
    // Customer capabilities and investigations are operational custody, not retained financial facts.
    if (['nc_move_rollback_plans','nc_native_reconfirmation_authority','nc_native_reconfirmations','nc_subscription_states','nc_dunning_recoveries','nc_dunning_mail_authority','nc_dunning_deliveries','nc_dunning_authority','nc_dunning_series','nc_retry_segments','nc_retry_method_recovery_authorizations','nc_retry_method_recovery_events','nc_retry_method_recoveries','nc_retry_churn','nc_retry_series','nc_retry_attempts','nc_card_expiry_notices','nc_card_expiry_notice_authority','nc_portal_method_actions','nc_portal_method_action_history','nc_automatic_collection_authorizations','nc_payment_link_attempts','nc_hosted_setup_returns','nc_hosted_setup_history','nc_hosted_setups','nc_portal_sessions','nc_portal_change_requests','nc_assurance_cases','nc_assurance_observations'].includes(table) && image.scoped) {
      mutations.push({ table, row, key, updates: null })
      const entry = changes.get(table) ?? { kind: table, fields: new Set<string>(), records: 0 }
      Object.keys(row).forEach(field => entry.fields.add(field)); entry.records++; changes.set(table, entry)
      continue
    }
    const updates: Row = {}
    const affected = image.scoped || (table==='nc_usage_batches' && images.some(i=>i.scoped && i.table==='nc_usage_events' && i.row.batch_id===row.id)) || (table === 'nc_audit' && ids.has(row.subject))
    for (const [column,value] of Object.entries(row)) {
      if (column in key || value === null) continue
      const shared = !affected && typeof value === 'string' && (column.endsWith('_json') || column === 'detail' || column === 'csv' || column === 'report_json') && (keyed(json(value),ids) || personal.some(v=>value.includes(v)))
      if (!affected && !shared) continue
      if (column.endsWith('_json') || column === 'detail') { updates[column] = affected ? blankJson(String(value)) : JSON.stringify(redactShared(json(value),ids,personal)); continue }
      if (column === 'csv') { updates[column] = affected ? '' : redactSnapshotCsv(String(value),personal); continue }
      if (!affected || typeof value !== 'string') continue
      if (column === 'token_hash') { updates[column] = null; continue }
      if (table==='nc_subscriptions'&&column==='trial_payment') { updates[column]=null; continue }
      if (foreignKeys.has(column) || (column.endsWith('_id') && !['external_id','event_id'].includes(column)) || column === 'id' || column === 'subject' || keep.has(column) || financialIdentifier(table,column) || typedPlanField(table,column) || /(?:_at|_on|_date|_from|_to|_start|_end)$/.test(column)) continue
      if (column === 'external_id' || column === 'event_id' || column === 'reference') updates[column] = `erased-${row.id ?? customer.id}`
      else if (column === 'name' && table === 'nc_customers') updates[column] = 'Erased customer'
      else if (['payment_intent_ref','charge_ref','payment_method_ref','refund_ref'].includes(column) || (table==='nc_payment_link_attributions'&&['customer_ref','session_ref'].includes(column))) updates[column]=`erased-${row.id ?? customer.id}`
      else if (column === 'provider_ref' || column === 'provider_schedule_ref' || column === 'stripe_customer_ref') updates[column] = required.has(column) ? `erased-${row.id ?? customer.id}` : null
      else updates[column] = column==='body' && table==='nc_notes' ? '[erased]' : ''
    }
    if(['nc_imported_collections','nc_processor_cash_imported_applications'].includes(table)&&affected&&row.charge_ref)updates.history_payment_id=images.find(image=>image.table==='nc_incumbent_history'&&image.row.kind==='payment'&&image.row.status==='succeeded'&&image.row.provider_ref===row.charge_ref)?.row.id??row.history_payment_id
    if (table==='nc_customers' && row.id===customer.id) { updates.status='archived'; updates.erased_at=Date.now(); updates.revision=crypto.randomUUID(); updates.tax_exempt=0 }
    if (affected) {
      if (['nc_usage_correction_mail','nc_credit_correction_mail','nc_draft_correction_mail','nc_notifications','nc_note_mentions','nc_renewal_notices','nc_card_expiry_notices'].includes(table)) updates.status='suppressed'
      if (table==='nc_cadence_deliveries') updates.status='superseded'
      if (table==='nc_webhook_deliveries') {updates.status='suppressed';updates.claim=null}
      if (table==='nc_remittances') updates.status='erased'
      if (table==='nc_notices') updates.status='discarded'
      if (table==='nc_tasks') updates.status='done'
      if (table==='nc_renewal_terms') {updates.auto_renew=0;updates.token_hash=null;updates.status='ended'}
      if (table==='nc_prepaid_topup_authorizations') updates.status='revoked'
      if (table==='nc_automatic_collections') updates.status='revoked'
      if (table==='nc_trial_collections') updates.status='revoked'
      if (table==='nc_prepaid_consents') updates.status='revoked'
      if (table==='nc_retention_offers') {updates.token_hash=null;updates.status='expired'}
    }
    if (table==='nc_audit' && affected) {updates.detail='{}'; updates.actor=memberIds.has(row.actor)?`member:${memberIds.get(row.actor)}`:/^(system:|customer:(erasure|renewal|winback))/.test(row.actor)?row.actor:'redacted-actor'}
    const fields=Object.keys(updates).filter(k=>updates[k]!==row[k])
    if (!fields.length) continue
    mutations.push({ table, row, key, updates: Object.fromEntries(fields.map(field => [field, updates[field]])) })
    const entry=changes.get(table)??{kind:table,fields:new Set<string>(),records:0};fields.forEach(f=>entry.fields.add(f));entry.records++;changes.set(table,entry)
  }
  return { generation,personalValues:personal, statements:erasureMutationStatements(mutations.sort((a,b)=>{const order=['nc_native_reconfirmation_authority','nc_native_reconfirmations','nc_dunning_recoveries','nc_dunning_mail_authority','nc_dunning_deliveries','nc_dunning_authority','nc_dunning_series','nc_retry_method_recovery_authorizations','nc_retry_method_recovery_events','nc_retry_method_recoveries','nc_card_expiry_notice_authority','nc_card_expiry_notices','nc_portal_method_actions'];const rank=(table:string)=>{const i=order.indexOf(table);return i<0?order.length:i};return rank(a.table)-rank(b.table)})), changes:[...changes.values()].map(v=>({...v,fields:[...v.fields].sort()})),ids:[...ids] }
}
