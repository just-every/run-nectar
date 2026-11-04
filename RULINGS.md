# Nectar contract rulings

### RL-108 — Customer financial visibility and erasure privacy

Date: 4 November 2026. Ruled by: ct. Governs: GOV-008. Source: the
sx-nectar-c-f103 gate-1 follow-ups and ct's 4 November contract-only split ruling.

Customer pages, lists and views may show invoice numbers, issue and due dates
and balances only to members entitled to `read.invoices`. Payment references
additionally require `read.payments`. Without those entitlements the
corresponding section is absent, with no count or existence hint, while a member
with `read.customers` can still open the customer page. For an erased customer,
every personal identifier is absent from the screen and ledger; retained invoice
numbers and totals remain visible only within invoice-read authority.

The frozen rubric requires the built customer page for ordinary and erased
customers: a Sales member without entitlements sees no ledger; an
invoice-entitled member sees authorized retained invoice fields; payment
references require the additional payment entitlement. Allowed and refused
paths must be exercised, with no mutation from refusal. The destination also
covers other customer pages, lists and views. The rubric is recorded in
`docs/contract/GOV-008-rubric.md`.

This additive Core clause starts missing with empty evidence. GOV-001, GOV-005,
all earlier clauses and judgments, homepage claims and existing inline rulings
remain unchanged. GOV-005's financial retention custody does not authorize
displaying personal identifiers on erased-customer screens or ledgers. There is
no field-proof exclusion or completion claim. The lane's supported hold pending
independent Opus review remains in force; this split does not authorize landing.

RL-108 follows the existing RL-107 reference in CONTRACT.md. Earlier rulings
remain where they were recorded; this addition neither reconstructs nor
renumbers them.
