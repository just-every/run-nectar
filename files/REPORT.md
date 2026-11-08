# sx-nectar-f25fix1 — blocking RPT-001 fixes

Repository: just-every/run-nectar
Product branch: cloud/sx-nectar-f25fix1
Product head: df4fdbbccf73d3f5320c8da217904c23bdb9e29c
Start: c268e667a84603f091672ae9e743851fa8ed1a4f
Merged main: 2df41cec83e718b014cf90827a32af5d68fdb38f
PR: none; this repository's supplied landing contract uses the named cloud branch and the fleet's independent gate/lander.

The full plan is PLAN.md. This FIX covers only blocking B (discount continuity when adopted items are replaced by seat changes) and blocking A (metered-price membership in captured normalized history). No campaign continuation, other clause, release, Base refresh or publication scan was performed.

## Blocking B — adopted scoped discounts

Before: importing and adopting a $100 monthly seat with a 10% product-restricted coupon, then approving two seats through change.prepare/change.decide, yielded $200 in the preview, normalized MRR source and issued July invoice. The correct total is $180. Repeated replacements also dropped the discount. before-discount.log records the failing aggregate assertion through the actual built Worker and its public import, adoption, change, report, invoice approval and issue doors.

Cause: import correctly bound narrow discounts to exact native item IDs; an approved quantity change closes that item and creates a new one. Both billing and normalized calculations matched only the closed ID.

Fix: ratingInputs retains explicit predecessor IDs from approved changes, following only same-price item replacements within the subscription. Saved rating operands retain that ancestry. The billing engine and normalized snapshot match the exact original item scope through it; they keep the original discount dates and do not broaden a discount to a sibling sharing the price. Read-only change previews, interval plan-change quotes and retained quote replay carry the same ancestry. No imported amendment or issued invoice is rewritten.

After: the original product-scoped item contributes $90 before cutover, $180 with two seats and $270 after the next replacement to three seats. After the recorded coupon expiry it contributes $300. Preview, normalized source and issued invoice agree. The item-scoped variant with an undiscounted sibling yields $190, $280, $370 and $400 respectively; the sibling remains exactly $100. browser-receipt.json contains the actual returned amounts, scopes, components and billed totals.

## Blocking A — metered-plan history continuity

Before: filtering a mixed $100 fixed plus metered subscription by either the source metered-price reference or its mapped native ID excluded the captured subscription. Historical months became zero; at adoption July appeared as new $100 MRR rather than continuation. before-membership.log records the failing aggregate assertion for MRR/ARR and both price identities before and after adoption.

Cause: capturedNormalizedInput deliberately removed metered items from the normalized money operands, and the report also used that shortened list for plan membership.

Fix: retain plan membership from the complete selected captured subscription snapshot, separately from fixed/seat money operands. The report applies its existing native/source alias matching to that complete membership; usage still contributes zero normalized money.

After: all nineteen months from January 2025 through July 2026 retain $100 MRR/$1,200 ARR through both source and mapped-native metered-price filters, before and after adoption. Only the first historical month has new MRR; adoption has zero new or expansion MRR. Every final contribution drills to its $100 fixed component. The metered-price filter retains the whole subscription without inventing usage MRR. Browser proof submits the mapped metered price through the native Plan price control and Show month form, so the selected plan and the continuous history are visible together.

## Integration

The full-history clone starts at the required candidate and has a merge/fix commit with both the candidate and current main as parents, followed by one compatibility repair commit. Both were pushed without rewriting history. Mechanical API and translation conflicts retain both sides. The report page retains normalized analytics plus main's declared-tax-source navigation. Main's newer CI structure stays intact; the candidate's existing normalized browser command is preserved in verification.json instead of restoring its obsolete workflow layout.

CONTRACT.md was resolved to main first. CONTRACT.md, ACCEPTANCE.md and docs/CLAIMS.md are byte-for-byte main's files on the product head. No Status, Gap or Evidence cell changed. Contract generation write/check passed; generated views were then restored from origin/main. The candidate amendment migration moved from 0110_amendment_items.sql to 0128_amendment_items.sql, above main's 0127; the rebuilt deployment spec and final source lock use the new path. No remaining reference uses the old path.

The initial deployment-spec check correctly detected the newly renumbered migration as stale. A real rer build and pnpm delivery:spec rebuilt it, and its final check passed. The edition source lock was regenerated last and checked before commit. A diff-whitespace check against the candidate's old parent noticed pre-existing vendor whitespace imported from main; no vendor source was altered. The final candidate diff against main passes git diff --check.

## Validation and proof

- Both final aggregate regression fixtures were rerun under Node 22.20.0 in an isolated worktree with the pre-fix logic restored from the original candidate. Both fail as expected: before-discount.log and before-membership.log. The fixture bytes equal the final committed test file; before-receipt.json and before-source.patch retain the exact reproduction basis. The pushed product checkout and head were untouched.
- The complete existing normalizedMetricsFlow passes, including both new assertions and the retained 18-month source-history, native calculations, discounts, correction custody, filters, CSV, source reconciliation, replay, authority and erasure checks: after-normalized.log.
- Related existing planChangesFlow, draftCorrectionsFlow and creditCorrectionFlow pass under Node 22.20.0: after-related.log.
- pnpm typecheck passes under Node 22.20.0: typecheck.log.
- Real rer build passed under the project's selected Node 22.20.0. Contract generator, deployment spec and edition source-lock checks pass: checks-receipt.json.
- The committed candidate reran both new aggregate assertions while real Chromium captured each changed screen once at 1440 and 390: discounted-seat report, its source detail and metered-plan history. All six navigations returned HTTP 200 and fit horizontally. The report visibly shows $180; metered history visibly shows uninterrupted $100 months with no adoption movement. Screenshots, hashes, actual values and exact product head are in browser-receipt.json and the six proof PNGs. The browser used /usr/bin/chromium with --no-sandbox; all browser contexts and harnesses were closed.
- No full local Verify, unrelated full-suite run or publication scan was run. Exact-SHA branch Verify supplies the full CI wall; ci-receipt.json records its latest actual state.

## Counts and clause custody

Before/after clause counts, relative to the integrated main source: 132 total; 62 done, 41 partial, 29 missing -> 132 total; 62 done, 41 partial, 29 missing. RPT-001 remains partial. No clause was promoted or demoted.

The candidate originally registered 89 isolated journeys; main now registers 100. Their mechanical union has 101, preserving the candidate's existing normalizedMetricsFlow. This FIX keeps that integrated 101 -> 101, adds exactly two aggregate regression assertions within the existing test file/journey and removes or weakens zero assertions. counts.json distinguishes inherited main registrations from FIX changes. This is a count of the isolated registry, not an unsupported claim about the whole repository's test count.

CLAIM RPT-001 PARTIAL points=none tests=tests/nectar/normalized-metrics.mjs#normalizedMetricsFlow
GAP RPT-001: The existing unqualified live-source analytics comparison and the rest of the clause's broader acceptance remain for the independent gate; this FIX makes no new completion claim.

## Product custody and evidence

The first real commit was pushed immediately after touched checks passed, through cloud-push.py, on attempt one. No main/default branch push, force push, rebase or published-history rewrite occurred. All ten candidate commits, including side parents, were inspected: only permitted fleet/owner author and committer identities, with no co-author trailers. The worktree was clean after each commit and push. custody-receipt.json, identity.log and push.log retain the actual provenance.

Reports are transported separately, using the supplied report-only entrypoint and only refs/heads/evidence/sx-nectar-f25fix1. They are never product files or a landing signal. No held provider keys, browser sessions, credentials, environment dumps or private gate material are selected. Exact CI status and evidence transfer identity are reported separately at completion.

## Exact-SHA CI failure and compatibility repair

The first product head 7ee65705781d0db30b1ec46e7bfd275369153a0d ran Verify 42495695583 and failed. This was not treated as green. Its source shard rejected the existing candidate metrics document because main's site manifest did not list it. Its flows-two shard and flows-three browser shard both found that main's existing move-in investigation proposal was refused with normalized_history_evidence_required. The normalizedMetricsFlow itself passed in that run. The final verify barrier failed as a consequence of required failed shards.

Each of the three causal failed jobs' log archives was read exactly once with gh run view --job ID --log-failed. No blob redirect retry, workflow rerun or empty commit was used. ci-failures.json and github-call-7.txt through github-call-9.txt retain the actual diagnostics. Nine of the ten permitted GitHub invocations were used for the first run's discovery, paced status reads, job identification and those three log reads.

The compatibility commit preserves main's complete documentation renderer and generated-claims page, registers the existing metrics document in docs/site.json and conforms its title to the renderer's existing rule. The real site build now passes with 21 pages. No generated contract view was edited.

For an imported subscription without complete historical snapshots, the existing move-in correction flow can still prepare its governed billing preview. Its normalized before/after snapshots explicitly have supported=false with captured_contract_history_unavailable. The preview fingerprints bind the exact inputs and retained history, including absence, so later source changes invalidate approval. UI and customer translations explicitly claim no normalized metric. Ordinary historical reports still refuse missing snapshots; no supported zero or native backfill is substituted. All existing move-in investigation assertions pass after this compatibility repair; none were edited, deleted or weakened. The exact same complete-history normalized journey also passes again, with both blockers fixed.

This repairs incompatibilities exposed by the required main merge; it does not add a clause, promote a status or continue the campaign. Final branch CI status is recorded separately in ci-receipt.json; a running run is never called READY.

The final head also passes the complete existing normalized-browser.mjs and clause-browser.mjs move-investigations commands with system Chromium. Eight final-head screenshots are retained: the six blocker screens plus the explicitly unavailable captured-MRR proposal at 1440 and 390. compatibility-browser-receipt.json records the latter, including the observed no-metric text and file hashes.

Final custody: PUSHED branch=cloud/sx-nectar-f25fix1 head=df4fdbbccf73d3f5320c8da217904c23bdb9e29c. Latest exact-SHA Verify run 42498064174: in_progress/None; https://github.com/just-every/run-nectar/actions/runs/42498064174. All ten permitted GitHub calls are used; no further API polling, log reads or workflow reruns occur. The candidate is pushed with local repairs and proof complete; it is not claimed READY while CI remains running. The fleet must independently verify this final SHA before landing.
