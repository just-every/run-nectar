# GOV-008 frozen review rubric

Source: ct's 4 November 2026 GOV privacy ruling, from the
sx-nectar-c-f103 gate-1 follow-ups. This is the review bar for the additive clause,
not implementation evidence or a completion judgment.

Use the built customer page with both an ordinary customer and an erased
customer whose retained financial facts are known. Exercise permitted and
refused paths through that page, using current member capabilities.

| Member entitlements | Required visible outcome |
| --- | --- |
| Sales with `read.customers`, without `read.invoices` or `read.payments` | Both customer pages open. Neither shows a ledger, invoice or payment section, count or hint that those records exist. |
| `read.customers` and `read.invoices`, without `read.payments` | Authorized invoice numbers, issue and due dates and balances are visible. Retained invoice numbers and totals remain readable for the erased customer. Payment references and their corresponding section, counts and existence hints are absent. |
| `read.customers`, `read.invoices` and `read.payments` | Authorized invoice fields and payment references are visible. The erased customer's screen and ledger still disclose no personal identifiers. |
| `read.customers` and `read.payments`, without `read.invoices` | Invoice and ledger information remains absent, including payment references, counts and existence hints. Payment entitlement does not substitute for invoice entitlement. |

For the erased customer, verify that every personal identifier is absent from
the screen and ledger, including names, email addresses, contact details and
any retained legal label that identifies the person. Financial retention alone
does not authorize its display. Authorized retained invoice facts must still
agree with the retained ledger.

Attempt the refused reads as well as the allowed reads. Confirm that refusals
disclose no protected fields or existence hints and change no customer, invoice,
payment or ledger data. A page-only check cannot establish the broader clause:
other customer pages, lists and views must obey the same entitlement and erasure
rules. All of this proof is producible within the seed; no field-proof exclusion
applies.

Current context paths at the split's main pin are
`src/nectar/receivables.ts`, `src/nectar/views.ts` and
`src/nectar/ui/customers.ts`. These are investigation pointers, not a restriction
on the clause's scope or a requirement to retain those paths.
