# sx-nectar-f37fix1

Scope: the sole BLOCKING A item, AGENT-005 webhook event item ordering (R6 clean control and mixed-case control). No acceptance status claim or publication scan.

Plan:
1. Clone full history, branch from ab8fc6ad978f2c5501da9b9b2d8a954f04f92eee, and merge origin/main.
2. Retain main CONTRACT.md whole, newer invoice service-period logic and assertions, workflows and other tests. Renumber candidate rollback migration above main's highest (0126 -> candidate 0127).
3. Extend the existing moveInvestigationsFlow clean-control fixture to two mixed-case price references. Add only one regression assertion through authenticated webhook.stripe.consume and move.investigate.
4. Run that probe against the old comparator, then apply the same deterministic comparator to both item arrays and rerun the journey and typecheck.
5. Regenerate/check contract documents, restore generated views from main, regenerate/check the source lock last, commit and push only the named product branch with identity checks.
6. Observe exact-SHA Verify using the bounded REST budget; publish this actual report and receipts separately on evidence/sx-nectar-f37fix1.

Merge baseline: origin/main 31a4c2af1c2d299b8f635c46db0c907fc686785b. Main's contract judgments retained whole. Its source-period regression fixture and assertion retained. No UI design changes are intended.

Before proof: `before-probe.log` records exit 1 at the sole added regression assertion: an authenticated event for the clean shadow subscription with prices `synthetic-nectar-price-Z` and `synthetic-nectar-price-a`, matching quantities of 2, opened one case. The original single-price quantity-difference and correction assertions are unchanged.

Fix: both native and captured item arrays sort with the same deterministic price-reference comparator before equality and basis hashing. No case lifecycle, authorization, quantity validation or duplicate-price check is weakened.

Local harness diagnosis: the initial ad hoc `node --input-type=module -e` runner passed that option into Miniflare's CommonJS synchronous-fetch worker and stalled on `getD1Database`. A real external `.mjs` entry point using the pinned Node 22.20.0 resolved it. Temporary startup diagnostics were removed and the harness remains identical to main. No product workaround was needed. Setup was retried after dependency-version/merge timing and migration-rename failures and after stopping only owned test PIDs.

After proof: `after-probe.log` records exit 0 for the entire existing moveInvestigationsFlow with the added assertion: no investigation is opened for identical mixed-case items. Existing genuine quantity differences, authorized correction/recheck/closure, old-event ordering, unsupported-state invalidation, rollback acknowledgement/custody, MFA, audit rollback and erasure regressions pass unchanged.

Local validation: setup, rer build, pnpm typecheck, generated-contract check and package edition-authoring source-lock check all passed. Source-lock check output is retained in source-lock-check.json. The old comparator probe failed as expected; one new regression assertion and zero new registrations were added. Contract counts remain 132 total / 62 done / 41 partial / 29 missing. Main's CONTRACT.md, generated views, harness and current Verify workflow/verification plan are byte-identical on the candidate. No Status, Gap or Evidence cell was changed.

CLAIM AGENT-005 PARTIAL points=none tests=tests/nectar/move-investigations.mjs#moveInvestigationsFlow
GAP AGENT-005: Existing main gaps and partial judgment remain; this round repairs only item-order equality and claims no complete webhook parity, live cutover, settlement or DONE status.

Browser regression: the existing focused move-investigations journey passed with Chromium at /usr/bin/chromium and --no-sandbox. Assertions run at 1440; all five clause states have once-at-1440 and once-at-390 screenshots, listed in browser/screens.json. The event-difference screenshots visibly show the mixed-case `synthetic-nectar-event-control` as Agrees with zero differences while the genuine single-price quantity mismatch still needs investigation. All browsers closed.

Merge handling: main's more recent invoice service-period selection and July-window fixture were retained, including the per-case August-period assertion. Main's shared assurance custody implementation was retained. Additive candidate customer/method/event and rollback integration remains; main's newer action/view routes and role tests were combined. An automatically duplicated, identical proposal-staleness guard was reduced to main's single copy. The rollback migration moved from 0114 to 0127; no old filename reference remains. API additions from both branches were retained. Source lock was generated after resolving and staging source changes. The generated view files were restored whole from origin/main and there is no diff against main for CONTRACT.md or either view.

Authorization regression: billingRolesFlow passed across preset/custom roles, financial field visibility, erasure, next-request revocation and unchanged financial state.

Product candidate: cloud/sx-nectar-f37fix1 at c7522ef6ad3ff44f13431b350d93c53e6bf06cfe. One new merge/fix commit combines the supplied candidate and current main. All six commits in origin/main..HEAD, including side parents, have fleet author/committer identity; trailers are absent and full messages contain no Codex/OpenAI co-author. Working tree is clean. No PR is required by the repository instructions; branch-push Verify is available.

Push custody: the cloud push guard succeeded on its first attempt, publishing only refs/heads/cloud/sx-nectar-f37fix1 at c7522ef6ad3ff44f13431b350d93c53e6bf06cfe. Verify was discovered through REST as push run 42482514923 on this exact SHA; initial status in_progress. CI polling is one watcher, at most once every 300 seconds, with ten total GitHub calls available. There has been no main/default-branch push, force push, publication scan, deployment or landing submission. No product blocker is known locally; independent gate remains owned by the lane.
