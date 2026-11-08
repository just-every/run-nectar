# sx-nectar-c-f107 — MOB-002 native feasibility and handoff

Result: BLOCKED on the required iOS Simulator build and runtime. The task supplies a Linux x86_64 VM and no macOS executor. Xcode and its iOS Simulator runtime require a macOS host. A browser screenshot, an uncompiled Swift source tree or injected desktop session would not establish the assigned native proof.

Repository: just-every/run-nectar
Inspected main and unchanged product HEAD: 2df41cec83e718b014cf90827a32af5d68fdb38f
Local branch: cloud/sx-nectar-c-f107
Product commits created: 0. Product branch pushed: no. PR: none. Candidate Verify run IDs: none. Run site: not run. Publication scan: not run; no product candidate exists. No READY or PUSHED custody is claimed.

## Check and counts

Read the inline plan, rules, ct rulings and all eleven DONE-RIDERS rows, the launcher's AGENTS.md, and the repository's AGENTS.md, CONTRACT.md and generated acceptance record. Current CONTRACT.md:453 defines the native apps, push and approval scope; its Status row at line 731 is missing with no evidence and gap “No native apps or push notifications.” The assigned simulator read-only slice does not replace that complete clause.

Before and after: 132 clauses, 62 DONE, 41 PARTIAL, 29 MISSING. MOB-002 remains MISSING. No Status, Gap, Evidence or acceptance text was changed. No plan rows changed. The older extract's counts are historical.

The actual capability receipt records uname, xcodebuild, xcrun simctl, adb, emulator and sdkmanager commands. Both Apple commands return exit 127. Android tools are also absent, and the VM has no exposed KVM device; these Android observations do not establish that installation or software emulation is impossible. The decisive dependency is a macOS execution host for the mandatory iOS native application and simulator journey. Signing credentials are not claimed necessary for simulator work. The separate held real-device, signing and push qualification remains owed.

## Full continuation plan

1. Assign the simulator slice to a macOS host with Xcode, an installed iOS Simulator runtime and an Android SDK with an emulator. Preserve the current repository pins and existing auth helpers. Do not request distribution signing or push access for this read-only simulator slice.
2. Create responsibility-split native applications at ./apps/ios/Nectar/ and ./apps/android/, with separate installation-origin validation, hosted authentication web session, allowlisted read transport, decoded read models, in-memory screen state and native presentation. Add no server auth route, bearer credential, financial operation or push registration.
3. Open unchanged hosted sign-in in each application's own web session. A test mail edge may capture the ordinary link, but the user journey must open the same-installation confirmation page and explicitly confirm there. Complete the existing required-factor page in that same session. Require the me response to identify a member actor. Never transfer cookies from h.signIn, a desktop browser or a fixture session. Preserve enterprise provider_required refusals.
4. Use only allowlisted same-origin GETs under the established session for identity, the current labelled reports, ageing, customer search and exact customer and invoice IDs. Validate redirects and origin; do not forward session authority to a second origin. Keep report and currency refusals visible and do not compute a more permissive substitute. Report current definitions faithfully rather than calling billed recurring revenue normalized MRR.
5. Seed controlled Worker and D1 facts through existing public customer, catalog, subscription, billing and recorded-payment doors. Freeze the measurement clock. Independently compute billed monthly recurring revenue, current-month billings and collections and USD ageing, and compare them with both native text and the ordinary web and API answers. Search a real issued invoice number and follow its exact existing customer and invoice IDs.
6. Qualify owner, finance and restricted roles; next-request role and membership revocation; required-factor holds; ordinary expired and replayed confirmation links; logout; unavailable reports; unsupported currencies; erasure and refused access. Refresh after foregrounding. Clear all financial screen state when backgrounded where necessary to prevent stale exposure, on logout and before presenting a refusal. Persist no offline financial data or cached financial responses. A deferred earlier response must not restore a cleared screen.
7. Implement one or a few simulator sanity journeys at ./tests/native/ios/ and ./tests/native/android/. Exercise actual native controls and hosted confirmation and factor forms. Assert at the width relevant to the flow, and inspect every changed native screen state at both 390 and 1440 in native test hosts. Browser captures alone prove no native acceptance. Integrate journeys through the repository's existing verification mechanisms without editing its Verify workflow or increasing the test cap.
8. Run builds, touched journeys and typecheck on that host. Generate contract views with node scripts/contract-docs.mjs write and check, then restore generated views whole from origin/main. Generate the source lock last with node node_modules/@runeditrun/rer/edition-authoring/cli.mjs lock and run its check. Keep the main Status cells unchanged. Publish coherent product commits on the named cloud branch with the fleet hooks, identity audit and push guard; keep all receipts on the separate evidence ref. Full clause DONE still requires the held actual-device, push and approval evidence.

## Existing source and fixture map — inspected, not rerun

- ./src/nectar/http.ts resolves current authority on every request and applies mfaHold before ordinary reads. API responses have no-store cache control. The native client must preserve these refusals.
- ./src/nectar/actor.ts:111 resolves member authority from the current session and current member status, and enforces the managed enterprise provider session. ./src/nectar/views.ts:161 exposes me with kind, role and capabilities.
- ./src/nectar/doors.ts:59 and :62 declare existing me, customers, exact customer, invoices, exact invoice and ageing reads. Its report doors at :64 expose existing report models.
- ./src/nectar/reports.ts:55 retains labelled billed monthly recurring revenue, billings, collections and AR definitions; :97 onward retains existing USD reporting checks and source-bound contributions. Read the returned definition and preserve the difference between recorded collections and bank settlement.
- ./src/nectar/collections.ts:24 provides the existing ageing read. ./src/nectar/customer-search.ts preserves capability-specific invoice-number matching and customer identification.
- ./tests/nectar/harness.mjs:15 runs the real Worker and D1, freezes local measurement time and substitutes mail only at its network edge. Its h.signIn helper at :102 returns a cookie for existing server journeys; that cookie-return path is explicitly unsuitable for seeding native app authentication. Reuse public fixture operations and mail observation, with native hosted confirmation instead.
- ./tests/nectar/reports.mjs#reportsFlow, ./tests/nectar/financial-reports.mjs#financialReportsFlow, ./tests/nectar/customer-search.mjs#customerSearchFlow and ./tests/nectar/billing-roles.mjs#financialVisibilityFlow provide existing server and browser fixture patterns. They were inspected as references only. Their pre-existing coverage establishes no iOS or Android execution in this run.

## Frozen rubric and unproved outcomes

| ID | Assigned outcome | This run |
| --- | --- | --- |
| R1 | Build and run both real native simulator applications with read-only home, customer search and exact invoice detail | UNMET: no apps exist; mandatory Apple runtime unavailable here |
| R2 | Each own hosted session completes ordinary sign-in, explicit same-installation confirmation and required MFA without copied cookies or tokens | UNMET: no native hosted-session journey run |
| R3 | Independently reconciled billed MRR, current-month billings and collections and USD AR ageing at one controlled time | UNMET: no native figures rendered |
| R4 | Issued-invoice-number search opens the exact existing customer and invoice IDs | UNMET: no native lookup journey |
| R5 | Owner, finance and restricted-role behavior; next-request revocation; factor holds; expired and replayed links | UNMET: no native allowed and refused journeys |
| R6 | Foreground refresh, logout, unavailable and currency refusal clear financial state; no offline financial cache | UNMET: no native lifecycle and storage proof |
| R7 | Every native state inspected at compact and wide sizes including 390 and 1440 native test hosts | UNMET: no native screen proof |
| R8 | No permission expansion, auth-server route, pinned helper edit, financial operation, bearer credential or push registration | INSPECTED: product tree unchanged; establishes no new feature |
| R9 | Full clause actual-device pushes, governed approvals, audit attribution and broader held interoperability and lifecycle qualification | UNMET-EXTERNAL and retained; no claim of completion |

## DONE-RIDERS on the inspected unchanged head

1. FAIL: no native journey reaches the target outcomes.
2. FAIL: no native real-data allowed and refused money or authority paths ran.
3. FAIL: no native journey was loaded in an exact-SHA Verify run.
4. NOT ESTABLISHED: no native candidate proof exists.
5. INSPECTED: acceptance and inherited duties unchanged; no new inheritance claim.
6. INSPECTED: source Status cells and generated views unchanged; no generated-view check claimed.
7. PASS by unchanged diff: no acceptance rewrite or obligation removed.
8. FAIL: no native owner and restricted-role authority journey.
9. PASS for report honesty only: device and provider qualification explicitly unproved.
10. NOT APPLICABLE: no implementation or policy default adopted.
11. PENDING: no product candidate, landing, exact-SHA candidate Verify, candidate Run site or publication scan.

## Pre-ready self-check and probes

No READY requested or asserted. No user-visible native behavior was implemented or tested; no existing assertion was removed, weakened, skipped or moved; authority, erasure and replay native paths remain unproved; no screens were touched. Product diff and index are empty. No migrations were added. All tests, typecheck, build, first-party check and native simulator journeys are NOT RUN because there is no implementation change and the mandatory Apple execution host is absent. The source lock and generated views were not modified or regenerated.

PROBE MOB-002: none, no native app exists and the required iOS Simulator runtime needs a macOS execution host absent from this task.
MECHANICAL lock=none exit=not-run; views=none exit=not-run; ledger=none exit=not-applicable.

CLAIM MOB-002 PARTIAL points=none tests=none
GAP MOB-002: No acceptance point closed. Both native apps and simulator journeys remain absent; required iOS Simulator proof needs a macOS host with Xcode and an iOS Simulator runtime. Original actual-device, signing, push, financial approval and held qualifications remain owed.
REMOTE-NEEDS-LOCAL: a macOS executor with Xcode and an iOS Simulator runtime is required for the mandatory iOS native build and simulator journey; this task has only Linux.

No product push was attempted, so there is no push rejection, failing HTTP status or unpushed product work to rescue. This packet contains only the actual report and non-secret capability receipt. Evidence publication is report-only and confers no product readiness or acceptance.
