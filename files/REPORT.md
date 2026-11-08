# sx-nectar-f96fix1 report

Repository: just-every/run-nectar
Product branch: cloud/sx-nectar-f96fix1
Product head: 1c2e40b4dbc06b27c8a80798ac7ca0c1fb7e987d
Merged main: 2df41cec83e718b014cf90827a32af5d68fdb38f
Original candidate: d875ed767cb04e9acfa1f159c7fb63fc5682cd0a

## Plan and integration

PLAN.md is the complete execution plan. A full-history clone started at the specified candidate. Main was merged without rewriting published history. Its newer CONTRACT.md, ACCEPTANCE.md and docs/CLAIMS.md won whole. Both sides' imports, API routes, test registrations, translations, and archive/erasure exclusions were retained. The candidate's browser and archive commands moved into main's existing verification plan, preserving all main commands. Migrations moved from 0116/0117 to 0128/0129 after main's highest 0127. The real build and delivery spec were regenerated and checked, followed by source lock generation/check. The integration save 7a744cc29228037d66d9702a051e58ee3f67eb13 was immediately pushed with [skip ci]. A fresh main fetch before the final commit found no further drift.

## Blocking A: list declaration

Before: the existing invoicePartialPayments view returned rows but lacked LIST_DOORS membership. API cursor requests returned 400 not_a_list, reproducing the pagination bar from run 40974492057. See before-probe.json/log for actual HTTP results.

After: invoicePartialPayments is declared as a list. Existing apiPlatformFlow passes its every-door list classification, cursor, query binding, version, authorization, generated-client and erasure checks. One additional assertion within the existing invoicePartialPaymentsFlow traverses actual prepared requests by cursor and compares IDs in complete list order. No new test registration was added.

## Blocking B: captured cash after address edit

Runtime confirmation came before the fix. For both an already submitted card Checkout and a dated ACH intent with available funds, the probe edited the customer's address through customer.update, then called reconciliation. Both returned 409 invoice_partial_source_changed, left paidCents=0 and allocations=0, retained open requests, and rejected ordinary payment allocation with invoice_partial_reserved. The defect was confirmed, not inferred from source alone.

The fix separates pre-submission approval freshness from accounting for an already claimed provider payment. All preparation, confirmation, customer acceptance and provider submission paths retain currentSource's full revision hash. Submitted reconciliation validates the retained basis hash, original immutable issued invoice ID/number/customer, amount, reserved balance and processor binding. sourceForPartial retains eligibility, active/unerased customer, currency, payer/route, reservation, dispute and conflict checks; nativeSourceGuard fences the current source and customer revision atomically with cash recording. Stripe proof still binds the account, customer, intent/request/invoice metadata, amount, currency, payment method and capture time; ACH still requires verified available funds. Receipt and allocation remain atomic with audit and reservation release. The same retained request format works for already claimed history and archives; no new authority is restored or provider write granted.

After: card reconciliation returned 200 collected, one USD 400 payment/allocation and USD 600 still owed; a separate ordinary USD 1 allocation succeeded, proving the stale reservation no longer blocks recovery. ACH reconciliation returned 200 collected with USD 1,000 recorded once and zero remaining debt; another allocation correctly refused exceeds_balance rather than invoice_partial_reserved. Replays added no allocation and reconciliation made zero provider POSTs. Full existing partial/card and dated ACH journeys also pass with address edits added after submission, including lost-response recovery, two-payment paid-invoice totals and reminder suppression. No existing test or assertion was removed, skipped or weakened. The address edits strengthen existing assertions without adding a second regression assertion for this item.

## Counts and clause custody

Blocking findings reproduced: 2. Locally fixed: 2. Exact-SHA Verify result is recorded in CI.json/RECEIPT.json when complete.

The old candidate had 131 total, 61 done, 42 partial and 28 missing; adopting main changes those inherited counts, not a FIX judgment. Main contract counts before and after: 132 total, 62 done, 41 partial, 29 missing. No clause Status, Gap or Evidence cell changed. Main's newer INV-007 missing judgment is retained whole; the builder continues to claim only the existing partial slice, not full acceptance. The original candidate had 93 isolated registrations; main has 100; the merged candidate has 101, preserving its one existing payment registration. FIX additions: zero registrations and one pagination assertion. All existing payment assertions remain.

CLAIM INV-007 PARTIAL points=none tests=tests/nectar/invoice-partial-payments.mjs#invoicePartialPaymentsFlow; tests/nectar/invoice-partial-payments.mjs#invoiceScheduledRemainderFlow
DEFAULT INV-007: Retain the existing conservative exact-invoice card and explicitly submitted dated-ACH slice; no unattended execution, missed-date catch-up or new collection authority.
GAP INV-007: Genuine full two-payment ACH settlement/timing qualification, full customer-scheduled execution, other providers and broader inherited acceptance remain unproved, unchanged by this FIX.

## Validation and publication

RECEIPT.json records the product SHA, tree, integrated main, actual commands/results, counts and checks. before-probe.json and after-probe.json hold actual HTTP outcomes. PROBE.mjs is the exact standalone diagnostic source (run from a checkout root, with imports from that checkout); it is evidence only. api-platform.log and partial-payments.log contain complete focused run output. Expected synthetic audit failures in partial-payments.log are deliberate rollback assertions; the process exits 0.

Typecheck, real build, focused API/payment tests, generated contract check, deployment-spec check, source-lock check and git diff --check pass. The real Chromium owner/customer form journey also passes on the exact candidate, with assertions at 1440 and 32 screenshots of the existing payment states at 1440 and 390 in browser/. The archive run passes in a separate unconfigured disposable worktree at parent f5d69c89053d90a4ba99162d7db377ad64dd44eb, because the main checkout was configured by required setup. Real export/reset/import retained exact cash and receipt identity, inert approvals, unresolved reservations, read-only recovery of the original card and ACH outcomes, erasure, and older-archive refusal. Its full actual output is partial-payments-archive.log. No publication scan ran, as the FIX brief expressly requires; the Mac lander owns publication checks. All eight candidate commits, including side parents, have fleet authors/committers and no disallowed trailers; hooks remain active. The final product push succeeded through cloud-push.py without retries. No PR was required or created. No main/default branch push, release, deployment, real provider write or contract judgment change was performed; provider traffic in the proof is the existing synthetic network edge.

Evidence publication is separate from product readiness. Only explicit non-secret reports and receipts are sent to evidence/sx-nectar-f96fix1; no product reports are committed on the cloud branch.

All local focused validation is complete: the archive process exited 0 after its erased import and original-outcome recovery assertions. Its temporary worktree and archive scratch were removed after completion. The final metadata-only repair has its own pending exact-SHA Verify, detailed below.

## Exact-SHA CI result and final custody

Initial product head f5d69c89053d90a4ba99162d7db377ad64dd44eb ran Verify 42495316208. Plan/build and fourteen other shards passed, including the API pagination/source checks and full browser/payment journeys. processor-supplemental-archive job 128776452968 failed because the merged verification plan ran the partial-payment archive proof after other CLI archive suites had configured the checkout. Those preceding suites passed. The partial-payment proof's unchanged fresh-checkout guard refused to run; it was not a cash, pagination or contract-generation failure. ci-jobs.json and ci-failed-archive.log contain the actual job evidence. The failed-job log archive command above succeeded once; no blocked blob download was retried. Public workflow command-environment wrapper rows were omitted from the shared failure log; all command/test output and the full assertion/stack are retained.

Commit 1c2e40b4dbc06b27c8a80798ac7ca0c1fb7e987d repairs this integration error by moving the same full archive command to flows-one, whose preceding journeys and browser use in-memory installations. The runner checkout is unconfigured there. Every command/assertion remains and the main shard count remains fifteen. This last commit changes only verification.json and sources.lock.json; all application/test source and browser proof are identical to the locally validated parent. Verification plan parsing, reusable-workflow permissions, contract documents and the regenerated source lock pass. Main was fetched again and was already merged. All three product pushes succeeded without retries or a force push.

Final Verify: run 42497610315, status in_progress, conclusion None, exact head 1c2e40b4dbc06b27c8a80798ac7ca0c1fb7e987d. URL: https://github.com/just-every/run-nectar/actions/runs/42497610315. The ten-call GitHub budget is exhausted (one unused erroneous discovery, six useful discovery/status calls on the first head, one job listing, one failed-job archive command, and final-head discovery). No further polling, rerun, dispatch or API calls were made. Product custody is PUSHED, not READY: final Verify is pending. This is not a claim of acceptance or landing. The initial red head is superseded by the pushed CI isolation repair, and its failure remains fully reported.

POST lanes/sx/INBOX.md: sx-nectar-f96fix1 pushed cloud/sx-nectar-f96fix1 1c2e40b4dbc06b27c8a80798ac7ca0c1fb7e987d; INV-007 blocking pagination declaration and captured-cash/address-edit cases fixed with before/after runtime proof; no contract cell changes (62 done/41 partial/29 missing, 132 total); initial Verify 42495316208 red only on archive checkout isolation, repaired without weakening tests; final Verify 42497610315 in_progress; GitHub budget 10/10, final exact-SHA green pending; keep existing PARTIAL claim.

The existing full browser payment journey was also rerun after the CI-only repair on final head 1c2e40b4dbc06b27c8a80798ac7ca0c1fb7e987d: it exited 0, re-exercising the pagination/card/ACH regressions through native owner/customer forms, with all 32 screenshots regenerated at 1440 and 390. partial-payments-browser.log includes the actual final SHA immediately before that successful run.
