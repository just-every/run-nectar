-- Schedule progress is observation bookkeeping, never executable authority.
ALTER TABLE nc_subscriptions ADD COLUMN state_checked_at INTEGER;
