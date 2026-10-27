// Capture native state in the source transaction, before another write or tick
// can hide it. These facts confer no collection or cancellation authority.
import type { Bindings } from '../auth.server'
import { clockInstant } from './clock'
import { all, canonical, newId, stmt, type Audit } from './core'
import { today } from './dates'
import { BALANCE_SQL } from './balance-sql'

const changesState = /^(subscription\.(?!state\.)|trial\.|automatic\.collection\.|collection\.|retry\.|dunning\.end\.|payment\.allocate|credit\.|invoice\.|balance\.|writeoff\.)/

export async function captureSubscriptionStates(env: Bindings, events: Audit[]) {
  if (!events.some(event => changesState.test(event.action))) return []
  const business = (await all(env, 'SELECT timezone FROM nc_business WHERE singleton=1'))[0]
  if (!business) return []
  const at = clockInstant(env), day = today(business.timezone, at), batch = newId()
  const refs = canonical([...new Set(events.flatMap(event => [event.subject, event.detail?.invoice, event.detail?.invoiceId, event.detail?.subscription, event.detail?.payment].filter(value => typeof value === 'string')))])
  const actions = canonical(events.map(({ actor, action, subject }) => ({ actor, action, subject })))
  // All source reads below execute after the business statements, inside their
  // D1 batch. A failed history, event or audit write rolls the source back too.
  const insert = stmt(env, `WITH refs AS (SELECT value FROM json_each(?)), invoices AS (
    SELECT id,subscription_id FROM nc_invoices WHERE id IN (SELECT value FROM refs) OR number IN (SELECT value FROM refs)
    UNION SELECT i.id,i.subscription_id FROM nc_invoices i JOIN nc_allocations a ON a.invoice_id=i.id WHERE a.id IN (SELECT value FROM refs) OR a.payment_id IN (SELECT value FROM refs)
    UNION SELECT i.id,i.subscription_id FROM nc_invoices i JOIN nc_native_collections a ON a.invoice_id=i.id WHERE a.id IN (SELECT value FROM refs)
    UNION SELECT i.id,i.subscription_id FROM nc_invoices i JOIN nc_automatic_collections a ON a.invoice_id=i.id WHERE a.id IN (SELECT value FROM refs)
    UNION SELECT i.id,i.subscription_id FROM nc_invoices i JOIN nc_dunning_series a ON a.invoice_id=i.id WHERE a.id IN (SELECT value FROM refs)
    UNION SELECT i.id,i.subscription_id FROM nc_invoices i JOIN nc_balance_entries a ON a.invoice_id=i.id WHERE a.id IN (SELECT value FROM refs)
  ), facts AS (
    SELECT s.*,? AS day,
      (SELECT id FROM nc_subscription_states WHERE subscription_id=s.id ORDER BY seq DESC LIMIT 1) AS previous_id,
      (SELECT state FROM nc_subscription_states WHERE subscription_id=s.id ORDER BY seq DESC LIMIT 1) AS previous_state,
      (SELECT observed_at FROM nc_subscription_states WHERE subscription_id=s.id ORDER BY seq DESC LIMIT 1) AS previous_at
    FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id
    WHERE s.billing_mode='live' AND c.status='active' AND c.erased_at IS NULL
      AND (s.id IN (SELECT value FROM refs) OR s.id IN (SELECT subscription_id FROM invoices)
        OR s.id IN (SELECT subscription_id FROM nc_trial_collections WHERE id IN (SELECT value FROM refs)))
  ), inputs AS (
    SELECT f.*,
      CASE WHEN start_date>day THEN 'scheduled' WHEN end_date IS NOT NULL AND end_date<=day THEN 'ended'
        WHEN EXISTS(SELECT 1 FROM nc_subscription_lifecycle l WHERE l.subscription_id=f.id AND l.kind='cancel' AND l.effective_date<=day
          AND COALESCE((SELECT r.effective_date FROM nc_subscription_lifecycle r WHERE r.related_id=l.id LIMIT 1),l.until_date,'9999-12-31')>day) THEN 'canceled'
        WHEN EXISTS(SELECT 1 FROM nc_subscription_lifecycle l WHERE l.subscription_id=f.id AND l.kind='pause' AND l.effective_date<=day
          AND COALESCE((SELECT r.effective_date FROM nc_subscription_lifecycle r WHERE r.related_id=l.id LIMIT 1),l.until_date,'9999-12-31')>day) THEN 'paused'
        WHEN trial_end IS NOT NULL AND trial_end>day THEN 'trialing' ELSE 'active' END AS lifecycle,
      (SELECT l.id FROM nc_subscription_lifecycle l WHERE l.subscription_id=f.id AND l.kind='cancel' AND l.effective_date>day
        AND NOT EXISTS(SELECT 1 FROM nc_subscription_lifecycle r WHERE r.related_id=l.id) ORDER BY l.seq DESC LIMIT 1) AS scheduled_cancellation,
      (SELECT json_group_array(json_object('id',id,'kind',kind,'effective_date',effective_date,'until_date',until_date,'related_id',related_id))
        FROM (SELECT * FROM nc_subscription_lifecycle WHERE subscription_id=f.id ORDER BY seq)) AS lifecycle_json,
      (SELECT json_group_array(json_object('id',id,'dueDate',due_date,'balanceCents',balance_cents)) FROM (
        SELECT i.id,i.due_date,${BALANCE_SQL} AS balance_cents FROM nc_invoices i
        WHERE i.subscription_id=f.id AND i.status='issued' AND i.issue_date<=day AND ${BALANCE_SQL}>0 ORDER BY i.due_date,i.id)) AS invoices_json,
      (SELECT json_group_array(json_object('id',id,'invoice',invoice_id,'status',status)) FROM (
        SELECT n.id,n.invoice_id,n.status FROM nc_native_collections n JOIN nc_invoices i ON i.id=n.invoice_id
        WHERE i.subscription_id=f.id AND i.status='issued' AND i.issue_date<=day AND ${BALANCE_SQL}>0 AND n.status IN ('declined','customer_action_required','uncertain')
        UNION ALL SELECT a.id,a.invoice_id,a.status FROM nc_automatic_collections a JOIN nc_invoices i ON i.id=a.invoice_id
        WHERE i.subscription_id=f.id AND i.status='issued' AND i.issue_date<=day AND ${BALANCE_SQL}>0 AND a.status IN ('refused','returned','uncertain') ORDER BY 1)) AS failures_json,
      (SELECT json_group_array(json_object('id',id,'policy_id',policy_id,'status',status,'end_date',end_date,'invoice_id',invoice_id)) FROM (
        SELECT d.* FROM nc_dunning_series d JOIN nc_invoices i ON i.id=d.invoice_id
        WHERE i.subscription_id=f.id AND d.end_date<=day ORDER BY d.id)) AS dunning_json,
      EXISTS(SELECT 1 FROM nc_dunning_series d JOIN nc_invoices i ON i.id=d.invoice_id
        WHERE i.subscription_id=f.id AND d.status='mark_unpaid' AND d.end_date<=day AND i.status='issued' AND ${BALANCE_SQL}>0) AS unpaid,
      (SELECT json_group_array(json_object('id',id,'invoice_id',invoice_id,'payment_id',payment_id,'amount_cents',amount_cents)) FROM (
        SELECT a.* FROM nc_allocations a JOIN nc_invoices i ON i.id=a.invoice_id WHERE i.subscription_id=f.id ORDER BY a.id)) AS allocations_json
    FROM facts f
  ), payment AS (
    SELECT inputs.*,CASE WHEN unpaid THEN 'unpaid'
      WHEN EXISTS(SELECT 1 FROM json_each(invoices_json) WHERE json_extract(value,'$.dueDate')<=day)
        OR EXISTS(SELECT 1 FROM json_each(failures_json) WHERE json_extract(value,'$.status')<>'uncertain') THEN 'past_due'
      WHEN json_array_length(failures_json)>0 THEN 'uncertain' ELSE 'current' END AS payment_status FROM inputs
  ), states AS (
    SELECT payment.*,CASE WHEN lifecycle IN ('active','trialing') AND scheduled_cancellation IS NOT NULL THEN 'canceled'
      WHEN lifecycle='active' AND payment_status IN ('past_due','unpaid') THEN payment_status ELSE lifecycle END AS state FROM payment
  ) INSERT INTO nc_subscription_states(id,subscription_id,customer_id,previous_id,previous_state,state,cause_json,observed_at)
    SELECT lower(hex(randomblob(16))),id,customer_id,previous_id,previous_state,state,
      json_object('day',day,'timezone',?,'startDate',start_date,'trialEnd',trial_end,'endDate',end_date,
        'lifecycle',json(lifecycle_json),'scheduledCancellation',scheduled_cancellation,
        'payment',json_object('status',payment_status,'invoices',json(invoices_json),'failures',json(failures_json)),
        'dunning',json(dunning_json),'allocations',json(CASE WHEN previous_state IN ('past_due','unpaid') AND state='active' THEN allocations_json ELSE '[]' END),
        'sourceBatch',?,'sourceActions',json(?)),?
    FROM states WHERE (previous_state IS NULL OR previous_state<>state) AND (previous_at IS NULL OR previous_at<=?)`,
  refs,day,business.timezone,batch,actions,at,at)
  const data = `json_object('subscription_id',subscription_id,'customer_id',customer_id,'transition_id',id,
    'previous_state',previous_state,'state',state,'cause',json(cause_json),'observed_at',observed_at)`
  return [insert,
    stmt(env, `INSERT INTO nc_webhook_events(id,type,customer_id,subject,payload_json,created_at)
      SELECT id,'subscription.state_changed',customer_id,subscription_id,json_object('type','subscription.state_changed','data',${data}),observed_at
      FROM nc_subscription_states WHERE json_extract(cause_json,'$.sourceBatch')=?`,batch),
    stmt(env, `INSERT INTO nc_audit(at,actor,action,subject,detail)
      SELECT observed_at,'system:lifecycle','subscription.state.observe',subscription_id,${data}
      FROM nc_subscription_states WHERE json_extract(cause_json,'$.sourceBatch')=?`,batch),
  ]
}
