-- One governed credit preparation per exact plan-change quote.
CREATE UNIQUE INDEX nc_plan_change_one_credit_request ON nc_plan_change_credit_requests(change_id);
