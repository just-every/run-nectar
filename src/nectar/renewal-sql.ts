// An automatically renewing term keeps meter ownership beyond its next boundary.
// Ending/cancelled terms release it at the actual saved subscription end.
export const serviceEndSql=(alias='s')=>`CASE WHEN EXISTS(SELECT 1 FROM nc_renewal_terms rt WHERE rt.subscription_id=${alias}.id AND rt.status='active' AND rt.auto_renew=1 AND rt.cancelled_at IS NULL) THEN '9999-12-31' ELSE COALESCE(${alias}.end_date,'9999-12-31') END`
