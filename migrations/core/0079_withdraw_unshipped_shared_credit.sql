-- Withdraw the branch-only experiment before main. Refuse unexpected history rather than discard financial custody.
INSERT INTO nc_guard(code,ok) SELECT 'shared_credit_history_requires_review',CASE WHEN NOT EXISTS(SELECT 1 FROM nc_hierarchy_credit_shares) THEN 1 ELSE 0 END;
DELETE FROM nc_guard WHERE code='shared_credit_history_requires_review';
DROP TABLE nc_hierarchy_credit_shares;
