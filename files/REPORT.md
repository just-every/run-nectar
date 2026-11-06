# sx-nectar-c-f106 — native TAX-003 source-report handoff

Repository: just-every/run-nectar
Branch: cloud/sx-nectar-c-f106
Candidate: 8d2f9661f3268826e3ec922c9b0d722131d3220a
Observed main: 1b5b0249a43f7483e8d6baa16d09436becff8d6c

CLAIM TAX-003 PARTIAL points=none tests=tests/nectar/tax-source-report.mjs#taxSourceReportFlow
GAP TAX-003: The native declared-source report is proved. Full connected Stripe Tax and AvaTax recorded-transaction and reversal reconciliation, complete test-clock quarters, provider filing formats and jurisdiction detail, complete credit, refund and void attribution, unsupported historical and currency and source variants, and TAX-001 provider prerequisites remain owed. The Avalara sandbox account is unavailable. Held Stripe credentials provide no tenant authority. No provider or legal qualification is claimed.

The planner's native report point is closed. Neither complete provider acceptance sentence is claimed closed, so the claim intentionally says points=none. No Status, Gap or Evidence cell changed. Source counts remain 62 DONE, 41 PARTIAL and 29 MISSING across 132 rows; no DONE increase is requested. TAX-003's stored row remains MISSING pending the lander's judgment of the PARTIAL claim. The intended plan update is native reporting implemented with all provider and unsupported-source remainders retained. No fleet plan, inbox or state file was changed.

## Result

Ordinary issued USD invoices contribute their immutable original signed line bases and original tax. Groups use the exact frozen declared jurisdiction, preserving an explicit missing group rather than deriving a destination from the customer. Taxable, exempt, non-taxable and unknown bases are separate. Explicit typed source corrections contribute only their saved tax component; ordinary credits remain whole, visible and unnetted. Credited subtotals are shown separately with unknown base classification. Original bases are never presented as net bases after credits.

The report, exact source detail and matching source CSV use the existing generic report doors. No new route pattern was necessary in `src/nectar/doors.ts`. Every report and source handler checks current report-read capability. CSV also checks export capability. Source details contain scalar frozen tax facts and selected financial line fields, without raw customer contacts, certificate documents or complete calculation inputs. No financial instruction or provider request was added. Existing homepage, branding, runtime pins and workflows are unchanged.

Entry points:

- `/app/reports/tax-sources?period=2026-Q3`
- `/api/nectar/reports/tax-sources?period=2026-Q3`
- `/app/reports/tax-sources/<source-id>?period=2026-Q3`
- `/api/nectar/reports/tax-sources/<source-id>?period=2026-Q3`
- `/app/exports/reports/tax-sources.csv?period=2026-Q3`

An optional customer filter scopes all source membership. Quarter selection defaults from the installation clock. Invoice issue dates and credit issue instants use business-local quarter boundaries. Unsupported currencies and prepaid funding sources are explicitly excluded; imported history is explicitly not covered. Provider filing formats are not claimed by the source CSV.

## Plan and execution

The full implementation plan is in `PLAN.md`. The work followed its six steps: preserve contract judgments and pins; construct a read-only frozen-source model; reuse report and export authority; prove native money and refusal outcomes through Worker and D1; inspect both screen widths and run touched checks; publish the product branch separately from this report packet.

Product commits, all authored and committed by the fleet with no co-author trailer:

- `1cf7e0927860520d128fac2157d16aae14b22de5` — initial native report save, with CI skipped.
- `506501242cec4a9ca9b64432361046125fbe4170` — scoped exports, source presentation, API documentation and qualification.
- `8d2f9661f3268826e3ec922c9b0d722131d3220a` — rendered amount and browser-download assertions.

Commit identities are also recorded in `PROVENANCE.json`. Each substantive commit was pushed using the fleet guard. All candidate commits and side parents were inspected with the required range log before every product push. Fresh main was fetched and merged before the final candidate; it was already an ancestor. No history was rewritten and no main or default branch was pushed. There is no PR because push is Verify's existing branch entry point.

## Frozen rubric and native proof

One public-door sanity journey, `tests/nectar/tax-source-report.mjs#taxSourceReportFlow`, performs the native source-report outcomes. Its fixtures are created through ordinary HTTP actions backed by real Worker and D1. Provider substitutions remain at the existing mail network edge; no tax provider is faked into a provider qualification. All lines below refer to the exact candidate above.

| ID | Checkable item or acceptance sentence | Result and proof |
| --- | --- | --- |
| P1 | Planner native USD quarter report by frozen declared jurisdiction | PASS locally. Lines 14–63 create TX and NY issued sources, an exemption certificate, taxable and non-taxable bases, quarter boundaries, a typed void credit and an ordinary credit. Independent totals are asserted at 56–63. |
| P2 | API, page, source and CSV agree with frozen lines and known credit tax | PASS locally. Lines 65–103 inspect every source and reconcile exported source sums and identities. Browser lines 182–211 assert actual displayed amounts and download the CSV through the page link. |
| P3 | Policy and exemption edits cannot rewrite issued evidence | PASS locally. Lines 133–140 change both settings and compare the report, saved lines and calculations. |
| P4 | Current-role, source-selection, revoked credential and export refusals change nothing financial | PASS locally. Lines 96–131 exercise refusals, allowed current report reads, scoped exports and unchanged invoices, payments and monthly tax facts. |
| P5 | Missing jurisdiction, unknown bases and unknown credit tax remain visible and unnetted | PASS locally. Lines 61–63 prove the ordinary 1100-cent credit does not invent a tax reversal. Lines 142–162 erase a source through the ordinary verified request and approval doors, then inspect missing jurisdiction, unknown 5500-cent base, anonymized source detail and CSV, and stable repeated reads. |
| N1 | TAX-003 gives taxable, exempt and tax amounts by state and jurisdiction per period, reconciled to invoices and credits | PARTIAL. Native declared-source arithmetic passes P1–P5; complete provider jurisdiction and all credit variants remain owed. Original bases are explicitly before later credit notes. |
| N2 | TAX-003 reconciles to connected Stripe Tax transactions and reversals and AvaTax committed documents | UNMET-EXTERNAL. No provider receipt; TAX-001 prerequisites remain incomplete and the Avalara account is unavailable. |
| N3 | TAX-003 exports the provider's filing format | UNMET. Source CSV is deliberately not a filing format. |
| A1 | After a test-clock quarter with Stripe Tax connected, state totals equal invoice tax less credits and the Stripe Tax export | PARTIAL. Native tax is independently 3300 less attributed 300, giving known tax 3000; provider connection, complete quarter and transaction export are unproved. |
| A2 | The same quarter with Avalara equals AvaTax committed transactions | UNMET-EXTERNAL. Avalara sandbox account unavailable. |
| D1 | Existing operating rule: exact money and immutable financial history | PASS locally. Integer cents reconcile independently at 56–93; read snapshots at 103 and 128–131 prove no financial mutation. Source reads use frozen amounts, never fresh rating. |
| D2 | Existing operating rule: current capability in each handler; agents gain no approval or export authority | PASS locally. Lines 105–127 exercise current custom-role changes, usage credentials, a revoked read credential and read-only agent export refusal. |
| D3 | Existing privacy custody: an erased source cannot be exposed or resurrected by repeated reads | PASS locally. Lines 142–162 verify anonymized and unknown source states without using old inputs or customer destination. No replay or restore authority is introduced by this read-only feature. |
| D4 | Touched UI is readable and usable at desktop and phone widths | PASS locally. Browser function at 168–214 checks rendered money at 1440, overflow at both widths and text at least 13px. The existing shell and new screens have visible labels on every control, so no new icon-only tooltip is required. Screens preserve existing borders and styling. No configuration screen was added. |

The native totals are independently $330 taxable base, $50 exempt base and $25 non-taxable base; original tax is $33, the explicit saved tax adjustment is −$3, and known tax is $30. An $11 ordinary credit is separate and unnetted. The TX group is $130 taxable, $50 exempt and $25 non-taxable with $13 original tax and −$3 attributed adjustment. The NY group is $200 taxable with $20 tax. After erasure, the former certificate invoice's $55 base moves to the missing-jurisdiction unknown-base group; current WA policy never fills that gap.

## DONE-RIDERS

No DONE claim is made. All eleven rows were nevertheless checked.

| Rider | Result | Exact proof or remaining condition |
| --- | --- | --- |
| 1 | FAIL for full clause; PASS native point | Native outcomes use `taxSourceReportFlow` lines 14–162 and 168–214. Provider and filing outcomes A1, A2, N2 and N3 remain unreached. |
| 2 | PASS locally | Populated source data and independent cents at 56–93; allowed reads and unsafe selection and authority refusals at 96–131; no financial mutation. |
| 3 | PENDING Verify | The new journey is registered at `tests/nectar/isolated-cases.mjs:102` and is loaded by Verify's existing flow commands. Candidate Verify is the exact-head push run recorded in `CI-final.json`; its last observed status is in progress with no conclusion. |
| 4 | PASS locally | `CHECKS.json` binds every touched run to 8d2f9661f3268826e3ec922c9b0d722131d3220a. Product source bytes are unchanged from the successful build before the last test-only commit. All eight screenshots were recaptured by the exact-head journey. |
| 5 | PASS for claimed duties | No new Base inheritance is claimed. Current capability, immutability and privacy duties remain the existing contract-wide operating rules and are proved by D1–D3. |
| 6 | PENDING lander bookkeeping | Generator write and check both pass, all Status rows remain byte-identical to main, and generated views are restored rather than committed. The stored TAX-003 Gap remains main's text by instruction; this report supplies the honest current GAP line. |
| 7 | PASS inspected | The complete original acceptance evidence is byte-identical. No acceptance point was added, rewritten or removed. Only the native implementation semantic and honest boundary were added before the existing acceptance text. |
| 8 | PASS locally | Current role, source membership and export refusals at 96–131. The feature adds no correction or refund verb or financial approval. |
| 9 | PASS inspected | Full provider and filing boundaries stay named in the report, API, page and clause. No receipt or legal qualification is claimed. |
| 10 | PASS inspected | No new policy default is adopted. Existing report-read and export authority is reused; no custody, spending, collection or outbound authority is granted. |
| 11 | PENDING guarded landing | Main does not equal the candidate. Full-history publication scan and candidate Run site are lander-owned. Exact-head Verify status is in `CI-final.json`: in progress, with no conclusion. No clause count is promoted here. |

## PRE-READY self-check

1. Native user-visible outcomes have populated assertions for actual money, source details, page figures and downloaded CSV; wrong state and authority are exercised. Full provider outcomes remain explicitly unproved. Exact-head local checks all exit zero; Verify is reported separately.
2. No existing assertion was deleted, skipped, narrowed or placed behind a width or branch condition. Existing isolated journey positions are retained by appending the new registration. Isolated registrations grow from 99 to 100; core check registrations remain 18. One new substantial public-door journey was added, with no cap increase and no pin test.
3. Revoked read credentials and removed report authority are refused, erased financial evidence remains anonymized and unknown, and repeated reads cannot resurrect the old evidence. No capture application, restore path or authority grant is introduced.
4. Report and source screens, known and missing-evidence states, are captured at 1440 and 390. The exact-head journey asserts readable text and no horizontal overflow. Existing shell styling, homepage and brand are preserved.
5. Source lock is fresh. Generator write and check pass before generated views are restored to main. Acceptance text and Status cells are unchanged. New changed lines contain no email-shaped address literal. Complete publication scanning, resulting-main equality and resulting-main Run site remain guarded lander gates; they are not represented as completed cloud checks.

PROBE TAX-003 native quarter: ordinary HTTP issue, credit and report doors -> frozen bases 33000, 5000 and 2500 cents; original tax 3300 less explicitly attributed 300 gives known tax 3000; ordinary credit 1100 is visible and unnetted.
PROBE TAX-003 source and export: current report reads and source membership succeed; revoked credential, removed role, foreign selection and missing export capability refuse; invoices, payments and existing monthly tax remain unchanged.
PROBE TAX-003 erasure: verified erasure request and approval followed by report, source and CSV -> missing jurisdiction and unknown 5500-cent base, anonymized customer and stable repeated reads.
MECHANICAL lock=node node_modules/@runeditrun/rer/edition-authoring/cli.mjs lock and check exit=0; views=node scripts/contract-docs.mjs write and check, then restore generated views exit=0; ledger=none exit=0.

## Terminal CI status

After one discovery and one run-status poll spaced more than 300 seconds apart, exact-head Verify 42226352937 is in progress with no conclusion. Four GitHub API calls were used in total, including main and superseded candidate discovery. No green candidate CI claim is made. The cloud brief limits waiting to a few minutes, so custody is PUSHED while Verify and the guarded landing gates remain pending. There is no known real candidate failure and no BLOCKED claim. The final head is remotely verified by ordinary Git. The independent lander can recheck the exact head and its gates.

## Checks and custody

`CHECKS.json` records command, real exit and duration for Node 22.20.0 typecheck, the tax-source journey including Chromium, the existing financial-report journey, the existing certificate journey, and first-party check. All five pass on the final candidate. `MECHANICAL.json` binds source-lock, generator and contract invariants to that head. `PROVENANCE.json` records commit identities, unchanged counts, the base, source files and screenshot hashes. The successful build's product bytes match the final candidate; the last commit changes only the test and generated source lock.

The original main is green: Verify 42111588197 (push, success) and Run site 42050832130 (push, success) both name 1b5b0249a43f7483e8d6baa16d09436becff8d6c. These are main's receipts and do not establish candidate green. Candidate Verify is 42226352937, event push, exact head 8d2f9661f3268826e3ec922c9b0d722131d3220a. Verify 42225984664 belongs to superseded 506501242cec4a9ca9b64432361046125fbe4170 and is not candidate proof. No workflow was dispatched or rerun.

Publication scan result: commit=8d2f9661f3268826e3ec922c9b0d722131d3220a; complete=false; historyScanned=false; findings=not-evaluated. The clone has full history, but cloud publication scanning is delegated to the maintained Mac lander by the brief. No zero-findings claim is made. Candidate main equality and Run site are pending guarded landing. Evidence publication is report transport only and signals no product acceptance or landing.

Product custody is PUSHED, with no DONE or landing assertion. The relevant packet is explicitly selected for `refs/heads/evidence/sx-nectar-c-f106`. Product files contain none of the report packet. No credential, environment dump, private gate material or symlink is selected. The clone is deleted only after product and evidence pushes succeed; the packet remains under the fleet work directory.
