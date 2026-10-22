// An issued invoice's balance: total less credit notes, carried correction credit,
// payment allocations and net write-offs (AR-004). A recovery pairs a payment
// allocation with the write-off it reverses, so a written-off invoice stays at
// zero while its net write-off falls.
export const WRITE_OFF_NET_SQL = `(COALESCE((SELECT SUM(amount_cents) FROM nc_write_offs WHERE invoice_id=i.id AND status='executed'),0) - COALESCE((SELECT SUM(amount_cents) FROM nc_write_off_recoveries WHERE invoice_id=i.id),0))`
export const GOODWILL_APPLIED_SQL = `COALESCE((SELECT SUM(amount_cents) FROM nc_balance_entries WHERE kind='application' AND grant_id IS NOT NULL AND invoice_id=i.id),0)`
export const BALANCE_SQL = `(i.total_cents - COALESCE((SELECT SUM(COALESCE(applied_cents,amount_cents)) FROM nc_credit_notes WHERE invoice_id = i.id), 0) - COALESCE((SELECT SUM(amount_cents) FROM nc_allocations WHERE invoice_id = i.id), 0) - COALESCE((SELECT SUM(amount_cents) FROM nc_usage_credit_applications WHERE invoice_id=i.id),0) - ${WRITE_OFF_NET_SQL} - ${GOODWILL_APPLIED_SQL})`
export const CARRIED_APPLICATION_SQL = `COALESCE((SELECT SUM(amount_cents) FROM nc_usage_credit_applications WHERE invoice_id=i.id),0)`
