# Nectar API

Everything a person does in Nectar's screens is also a JSON call under
`/api/nectar/`. The same handler serves both doors and checks the caller's
role or credential scope itself.

## Who can call

- **A signed-in person** sends their session cookie. Posts must carry this installation's `Origin` header.
- **An agent or pipeline** sends `Authorization: Bearer nectar_…`, a credential the owner issues under More → Access (or `credential.issue`). The key is shown once; Nectar stores only its SHA-256. Scopes:
  - `prepare`: every read below, and `proposal.create`.
  - `usage`: `usage.submit` only.

  A credential never approves, finalises, issues a credit, edits a record or manages access; those calls answer `403`. A revoked key answers `401`.

## Reads (GET)

`me`, `business`, `customers`, `customers/ID`, `catalog`, `subscriptions/ID`,
`usage/batches`, `usage/inspect?period=YYYY-MM`, `runs`, `runs/ID`,
`invoices/ID`, `ageing`, `payments`, `notices`, `tasks`, `proposals`,
`proposals/ID`, `entitlements/CUSTOMER` (all features held today) and
`entitlements/CUSTOMER?feature=CODE&date=YYYY-MM-DD` (one decision, explained
step by step; `CUSTOMER` may be the internal id or the external id), `imports`,
`shadow`, `members` and `credentials` (owner), `audit`.

## Actions (POST, JSON body)

| Action | Who | Body |
| --- | --- | --- |
| `business.configure` | owner | `legal_name`, `timezone`, `invoice_prefix`, `payment_terms_days`, optional `address`, `billing_email`, `revision` when editing |
| `tax.declare`, `tax.review` | owner | `tax_jurisdiction` (state), `tax_mode` (`no_tax`, `flat_rate`), `tax_rate`, `tax_note`; review takes `revision` |
| `customer.create`, `customer.update`, `contact.add` | owner, finance | `external_id`, `name`, `billing_email`, `address`, `tax_exempt`, `tax_exempt_ref`; update adds `customer`, `revision` |
| `product.create`, `meter.create`, `price.create`, `price.retire`, `feature.grant` | owner, finance | price: `product`, `kind` (`flat`, `seat`, `unit`), `unit_amount` (decimal text), `meter` for `unit`, `taxable`, `nickname` |
| `subscription.create` | owner, finance | `customer`, `start_date`, `anchor_day`, `trial_end`, `price[]`, `quantity[]`, optional `exception_*` |
| `amendment.propose` / `amendment.decide` | finance / a person with approval | `subscription`, `kind`, `value`, `effective_from`, `effective_to`, `price`, `note`, `clause` / `amendment`, `decision` |
| `change.prepare` / `change.decide` | finance / a person with approval | `subscription`, `item`, `price`, `quantity`, `effective_date` / `change`, `decision` |
| `subscription.end` | a person with approval | `subscription`, `end_date` |
| `usage.submit` | owner, finance, `usage` credential | `events: [{event_id, customer, meter, quantity, occurred_at}]` (up to 5,000; times ISO 8601 with an offset) or a CSV `file` |
| `usage.control` | owner, finance, `usage` credential | `customer`, `meter`, `day` (billing timezone), `expected_count`, `expected_quantity`; identical submissions change nothing |
| `usage.acknowledge` | a person with approval | `control`, exact `basis` from `usage/inspect`, `reason`; any later event or source change invalidates acknowledgement |
| `billrun.prepare` | owner, finance | `period` (`YYYY-MM`) |
| `invoice.approve` | a person with approval | `invoice` or `run`, `acknowledge` when exceptions are listed |
| `invoice.finalise` | a person with approval | `invoice` or `run`, optional `issue_date` |
| `credit.issue` | a person with approval | `invoice`, `amount`, `reason` |
| `payment.record`, `payment.allocate` | owner, finance | `customer`, `amount`, `received_on`, `method`, `reference`, `evidence` / `payment`, `invoice`, `amount` |
| `reminder.prepare`, `reminder.approve`, `reminder.discard`, `task.create`, `task.complete` | owner, finance (approve and complete: a person) | `customer` / `notice`, `recipient`, `subject`, `body` / `task`, `outcome` |
| `proposal.create` | owner, finance, `prepare` credential | `kind`, `title`, `payload`, `evidence` (below) |
| `proposal.decide` | a person with approval | `proposal`, `decision` (`approved`, `rejected`), `note`; collections may set `recipient`, `subject`, `body` |
| `import.preview`, `import.apply`, `import.job` | owner, finance (a person) | see [IMPORTING.md](IMPORTING.md) |
| `subscription.adopt` | owner | `subscription`, `cutover_start`, `acknowledge_unreconciled` |
| `access.give`, `access.end`, `credential.issue`, `credential.revoke` | owner | `email`, `name`, `role` / `member` / `name`, `scopes[]` / `key` |

Amounts are decimal text (`"499.00"`, `"0.0004"`); money is answered in integer
cents (`total_cents`). Errors answer `{ "error": "code", "detail": … }` with
400 (invalid input), 401, 403, 404 or 409 (a stale, already-decided or
changed-since-approval record).

## Proposals: the agent prepares, a person approves

Nectar computes every amount in a proposal itself and records the source
versions it was prepared against. Approval re-reads them and refuses a stale
proposal (`proposal_stale`).

- **`amendment`** — contract terms from a signed agreement. `payload`: `subscription`, `kind` (`discount_percent`, `fixed_credit`, `price_override`), `value`, `effective_from`, optional `effective_to`, `price`, `note`. `evidence.clauses` (required): `[{quote, reference}]`; `evidence.ambiguities`: what the agreement leaves open. Never guess a renewal date, tax treatment or missing commitment: list it as an ambiguity. Nectar returns the effect on the period the terms start and the next.
- **`price_change`** — a new price version for selected subscriptions. `payload`: `product`, `kind`, `unit_amount`, `meter`, `nickname`, `taxable`, `effective_date`, `subscriptions[]`. Nectar returns each subscription's before and after for the affected and next period. Approval writes the version and moves exactly those subscriptions from that date.
- **`usage_correction`** — bill-run exceptions. `payload`: `void: [{event_id, reason}]`, `add: [events]`, optional `run` (a draft bill run). `evidence.sources` (required). Approval voids and adds, and re-prepares the run; its invoices still need their own approval.
- **`collection`** — a reminder. `payload`: `customer`, optional `recipient`, `subject`, `body`. The person approving sets the final recipient and wording.

Example, with a `prepare` credential:

```sh
curl -X POST "$ORIGIN/api/nectar/proposal.create" \
  -H "Authorization: Bearer $NECTAR_KEY" -H 'content-type: application/json' \
  -d '{"kind":"amendment","title":"Renewal discount","payload":{"subscription":"SUB_ID","kind":"discount_percent","value":"20","effective_from":"2026-09-15"},"evidence":{"clauses":[{"quote":"…reduced by twenty percent (20%).","reference":"Order form §2"}]}}'
```

`usage/inspect` includes daily `controls` with expected and ingested counts and exact quantities, differences, acknowledgement and basis. A mismatch blocks invoice approval even with the generic exception checkbox. Replaying missing usage or acknowledging the exact difference clears it on re-preparation. Changes after invoice approval invalidate issue.

## Quantity pricing (`CAT-002`)

`price.create` keeps `kind: "seat"` or `"unit"` and accepts `pricing_model`:
`graduated`, `volume`, `package`, or `stair_step`. Supply `tiers` as an array
of `{up_to, unit_amount, flat_amount}`. All quantities and dollar amounts are
exact decimal strings with at most six places; the final `up_to` is `null`
(no limit), earlier limits increase strictly and are inclusive. Omit the
simple `unit_amount` field when supplying a model.

Graduated pricing charges each occupied band's units and optional flat fee.
Volume pricing charges all units at the band reached, plus its optional fee.
Stair-step pricing charges only the band's required `flat_amount` (unit rate
is omitted or zero). Package pricing uses one unlimited tier and a positive
`package_size`: it charges whole blocks, rounded up, plus the optional fee.
Zero units activate no band or fee. Tier sums remain exact until the invoice
line is prorated and rounded once. Seat quantities may be zero for these
models. A scalar contract price override is refused for a tiered price;
create an immutable price version with the agreed tiers instead.

```json
{"product":"PRODUCT_ID","kind":"unit","meter":"api_calls",
 "pricing_model":"graduated","tiers":[
   {"up_to":"1000","unit_amount":"0.002","flat_amount":"0.006"},
   {"up_to":null,"unit_amount":"0.0014","flat_amount":"0.006"}]}
```

The catalogue returns parsed `pricing` terms. Invoice lines expose the exact
band quantities, rates, fees and amounts in `evidence.tiers`, with the exact
sum and proration used for final rounding. The catalogue and invoice screens
show the same breakdown. Modeled invoices record a separate calculation rule
version; existing simple-price inputs and issued invoices retain their rules.
