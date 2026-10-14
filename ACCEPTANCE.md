# Nectar acceptance record

Status: **all sixteen first-release clauses are LOCAL PROVEN.** Each clause in
[CONTRACT.md](CONTRACT.md) has one flow check in `tests/nectar/flows.mjs`
(`pnpm run test:flows`, part of `rer verify`), which builds the Worker and
drives it with real local D1 only through its public doors: the JSON API
(member sessions and bearer credentials), the HTML form door, pages and
downloads. The owner journey in `tests/nectar/journey.mjs`
(`pnpm run test:journey`, run from a disposable fresh clone) repeats a whole
billing cycle by hand in a real browser at 1440 pixels, renders every main
screen at 390 pixels, and proves the restore through `rer export` and
`rer import`. This covers the local first release only; it does not claim
hosted operation, provider behaviour, tax correctness or a real buyer's
invoice comparison.

| # | What a person can do | Test target | Status |
| --- | --- | --- | --- |
| 1 | Set up the business identity, USD, billing timezone and a declared tax policy that must be reviewed before finalising | `NEC-01 business, currency, timezone and declared tax`; finalising refused until review in `NEC-10` | **LOCAL PROVEN** |
| 2 | Keep customers and billing contacts under unique external ids, with exemptions backed by a reference | `NEC-02 customers and billing contacts with external ids` | **LOCAL PROVEN** |
| 3 | Version products, flat, seat and per-unit prices and meters; earlier versions never change | `NEC-03 products, immutable price versions and meters` | **LOCAL PROVEN** |
| 4 | Start subscriptions with a billing day, trial and contract exceptions that bill only once approved | `NEC-04 subscriptions with anchor, trial and approved exceptions` | **LOCAL PROVEN** |
| 5 | Import or submit usage with stable ids; duplicates change nothing, conflicts and bad rows are reported | `NEC-05 usage with stable ids and duplicate rejection`; credential submission in `NEC-14` | **LOCAL PROVEN** |
| 6 | Inspect exact period totals, timezone boundaries, gaps, late and unrated events before rating | `NEC-06 missing and late usage and exact totals before rating` | **LOCAL PROVEN** |
| 7 | Rate fixed, seat and unit charges with exact decimals, proration and explicit rounding, reproducibly | `NEC-07 deterministic rating with explicit rounding` | **LOCAL PROVEN** |
| 8 | Schedule plan and quantity changes from a previewed proration; the bill equals the approved preview | `NEC-08 scheduled changes bill exactly as previewed` | **LOCAL PROVEN** |
| 9 | Draft a bill run, compare with previous invoices and runs, list exceptions; late usage bills next period | `NEC-09 draft bill run comparison and exceptions` | **LOCAL PROVEN** |
| 10 | Approve and finalise numbered invoices bound to their inputs; source changes invalidate approval; nothing bills twice | `NEC-10 approval, source changes and numbered finalisation` | **LOCAL PROVEN** |
| 11 | Issue credit notes and allocate externally evidenced payments without breaking total = credited + paid + owed | `NEC-11 credit notes, payment evidence and allocations` | **LOCAL PROVEN** |
| 12 | See ageing, approve a reminder's exact recipient and wording while balances hold, export it, close the follow-up | `NEC-12 ageing, reminder drafts and follow-up tasks` | **LOCAL PROVEN** |
| 13 | Export invoices, usage, subscriptions and bill runs with calculation evidence; restore the installation; explain entitlements | `NEC-13 exports and entitlement explanations`; restore round trip in `tests/nectar/journey.mjs` | **LOCAL PROVEN** |
| 14 | Let an agent prepare contract terms, price changes, usage corrections and reminders that only a person approves | `NEC-14 agent prepares, a person approves` | **LOCAL PROVEN** |
| 15 | Owner controls access; every handler enforces roles; signed-out and cross-site requests get nothing | `NEC-15 roles are enforced in every handler` (crawls every action and every GET door) | **LOCAL PROVEN** |
| 16 | Move in from Stripe Billing: dry run, journal, undo, shadow comparison, cutover without replaying billed periods | `NEC-16 Stripe Billing move-in with dry run, journal, undo and shadow cutover` | **LOCAL PROVEN** |

## What the proposal's acceptance asks, and where it is proven

- **Duplicate usage does not double-bill:** a repeated event id changes nothing (`NEC-05`); a billed event is marked inside the issuing transaction and an issued period is never drafted again (`NEC-10`).
- **A timezone boundary and a late event remain explainable:** 23:30 on 31 July in Los Angeles belongs to July even though it is 1 August in UTC (`NEC-06`); an event for an invoiced month bills next month as a late-usage line naming its period and event id (`NEC-09`).
- **Proration agrees with the approved preview:** `NEC-08` compares the bill run's fixed, seat and discount lines with the approved preview line for line.
- **Source changes invalidate approval:** a usage event arriving after approval stops that invoice at finalising while the unchanged one issues (`NEC-10`); a proposal prepared against older records is refused (`NEC-14`).
- **Credits and allocations preserve the receivable:** over-credit and over-allocation are refused inside the batch and the invoice and customer ledgers balance (`NEC-11`).
- **Imported subscriptions cannot charge:** moved-in subscriptions are shadow drafts that cannot be approved, and adoption refuses any cutover inside a period Stripe billed (`NEC-16`). Nectar has no payment collection path at all.
- **Restore retains the calculation evidence:** the journey exports the populated installation, refuses a corrupt and a second import, restores into a fresh clone, exports again with every portable row equal, and reads each issued invoice's calculation fingerprint back from the restored app.

## Evidence

Worked figures from the tests: Northwind's July invoice bills $499.00 + 5 seats × $30.00, a 10% contract discount of −$49.90 and −$15.00 (rounded per line), and 3,346,778.5 events × $0.0004 = $1,338.7114 → $1,338.71, subtotal $1,922.81, tax 8.25% = $158.632 → $158.63, total $2,081.44; Pinecrest's trial ends 29 July, so 17 of 31 days of $499.00 bill $273.65 with no tax for its exemption.

`rer verify` runs the Worker checks and every acceptance flow, and CI runs it on every change. The browser journey and restore round trip run from a disposable fresh clone with `NECTAR_TEST_CHECKOUT=1 pnpm run test:journey`. Hosted operation is not claimed.
