-- DEV-001: the import target's parent INSERT precedes its items. Capture
-- after the complete target and its provenance have been written atomically.
-- No historical backfill and no event emission during archive restoration.
DROP TRIGGER nc_webhook_import_subscription_created;
CREATE TRIGGER nc_webhook_import_subscription_complete AFTER INSERT ON ik_provenance
WHEN NEW.target_kind='subscription' AND NEW.reversed=0
 AND NOT EXISTS(SELECT 1 FROM nc_privacy_context)
 AND NOT EXISTS(SELECT 1 FROM rer_portability_state WHERE id=1 AND applying=1)
 AND EXISTS(SELECT 1 FROM nc_webhook_endpoints WHERE enabled=1)
BEGIN
 INSERT INTO nc_webhook_events(id,type,customer_id,subject,payload_json,created_at)
 SELECT lower(hex(randomblob(16))),
  CASE WHEN json_extract(NEW.record_json,'$.before') IS NULL THEN 'subscription.created' ELSE 'subscription.updated' END,
  s.customer_id,s.id,json_object(
   'type',CASE WHEN json_extract(NEW.record_json,'$.before') IS NULL THEN 'subscription.created' ELSE 'subscription.updated' END,
   'data',json_object('id',s.id,'customer_id',s.customer_id,'billing_mode',s.billing_mode,'end_date',s.end_date,
    'items',json((SELECT json_group_array(json_object('id',i.id,'price_id',i.price_id,'quantity',i.quantity,'effective_from',i.effective_from,'effective_to',i.effective_to)) FROM nc_items i WHERE i.subscription_id=s.id))),
   'metadata',json_array(
    json_object('kind','customer','id',s.customer_id,'metadata',json(COALESCE((SELECT metadata_json FROM nc_metadata_revisions WHERE kind='customer' AND record_id=s.customer_id ORDER BY revision DESC LIMIT 1),'{}'))),
    json_object('kind','subscription','id',s.id,'metadata',json(COALESCE((SELECT metadata_json FROM nc_metadata_revisions WHERE kind='subscription' AND record_id=s.id ORDER BY revision DESC LIMIT 1),'{}'))),
    json_object('kind','prices','objects',json((SELECT json_group_array(json_object('kind','price','id',p.id,'metadata',json(COALESCE((SELECT metadata_json FROM nc_metadata_revisions WHERE kind='price' AND record_id=p.id ORDER BY revision DESC LIMIT 1),'{}')))) FROM nc_prices p WHERE p.id IN(SELECT price_id FROM nc_items WHERE subscription_id=s.id))))
  )),CAST(unixepoch('subsec')*1000 AS INTEGER)
 FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id
 WHERE s.id=NEW.target_id AND s.origin='import' AND c.erased_at IS NULL;
END;
-- Operational receipt keys never re-enable destinations after an archive restore.
CREATE TABLE nc_webhook_stripe_receipts(account_ref TEXT NOT NULL,provider_event_ref TEXT NOT NULL,customer_id TEXT NOT NULL REFERENCES nc_customers(id),event_id TEXT NOT NULL,PRIMARY KEY(account_ref,provider_event_ref));
