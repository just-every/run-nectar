# Nectar API

Everything a person does in Nectar's screens is also a JSON call under
`/api/nectar/`. The same handler serves both doors and checks the caller's
role or credential scope itself.

## Who can call

- **A signed-in person** sends their session cookie. Posts must carry this installation's `Origin` header.
- **An agent or pipeline** sends `Authorization: Bearer nectar_…`, a credential the owner issues under More → Access (or `credential.issue`). The key is shown once; Nectar stores only its SHA-256. Scopes:
  - `prepare`: every read below, `answer.read`, `answer.propose` and `proposal.create`.
  - `usage`: `usage.submit` and `usage.control` only.

  A credential never approves, finalises, issues a credit, edits a record or manages access; those calls answer `403`. A revoked key answers `401`.

## Reads (GET)

`me`, `business`, `customers`, `customers/ID`, `catalog`, `subscriptions/ID`,
`usage/batches`, `usage/inspect?period=YYYY-MM`, `runs`, `runs/ID`,
`invoices/ID`, `customers/ID/balance`, `ageing`, `promotions`, `write-offs`, `ledger-postings`, `period-closes`, `payments`, `notices`, `tasks`, `proposals`,
`proposals/ID`, `entitlements/CUSTOMER` (all features held today) and
`entitlements/CUSTOMER?feature=CODE&date=YYYY-MM-DD` (one decision, explained
step by step; `CUSTOMER` may be the internal id or the external id), `imports`,
`shadow`, `members` and `roles` (owner), `credentials` (owner or developer), `audit`.
Each door answers only within the caller's record families (`GOV-001`): a
collections, sales, support or custom-role member gets 403 `forbidden` on
records their role does not read.

## Actions (POST, JSON body)

| Action | Who | Body |
| --- | --- | --- |
| `business.configure` | owner | `legal_name`, `timezone`, `invoice_prefix`, `payment_terms_days`, optional `address`, `billing_email`, `revision` when editing |
| `tax.declare`, `tax.review` | owner | `tax_jurisdiction` (state), `tax_mode` (`no_tax`, `flat_rate`), `tax_rate`, `tax_note`; review takes `revision` |
| `customer.create`, `customer.update`, `contact.add` | owner, finance | `external_id`, `name`, `billing_email`, `address`, `tax_exempt`, `tax_exempt_ref`, optional `language` (PORT-006: a complete translation file's tag, `en` or `es-US` today; default `en`, omitted on update keeps it; anything else is `unsupported_language`); update adds `customer`, `revision` |
| `exemption.claim` | owner, finance | `customer`, `state`; records a claim while its document is missing |
| `certificate.collect` | owner, finance | `customer`, `state`, `reference`, `valid_from`, `expires_on` (inclusive), `file` (PDF/PNG/JPEG, max 500 KB) |
| `certificate.review` | a person with approval | `certificate`, `decision` (`validated`, `rejected`), `review_note`; a decision is permanent |
| `certificate.policy` | owner | `enabled` (boolean); unattended certificate mail is off until the owner enables it |
| `certificate.remind` | owner, finance (a person) | no fields; run the daily expiry check now |
| `product.create`, `meter.create`, `price.create`, `price.retire`, `feature.grant` | owner, finance | price: `product`, `kind` (`flat`, `seat`, `unit`), `unit_amount` (decimal text), `meter` for `unit`, `taxable`, `nickname` |
| `charge.add` | owner, finance | `customer`, optional `subscription`, `effective_date`; either `price` and optional decimal `quantity`, or custom `amount`, `description`, `taxable` |
| `invoice.manual` | owner, finance | `customer`, `charges[]` (1–20 unbilled charge ids), `service_date`; returns a standalone draft for normal approval and issue |
| `subscription.addon` | a person with approval | `subscription`, `price`, seat `quantity`, `effective_date`; attaches an immutable catalogue price with recurring proration |
| `subscription.create` | owner, finance | `customer`, `start_date`, `anchor_day`, `trial_end`, `price[]`, `quantity[]`, optional `exception_*`, optional `trial_payment` (`card` or `none`, with `trial_end`) and `promotion_code` (redeemed in the same transaction) |
| `coupon.create` | a person with approval | `name`, `kind` (`percent` or `amount`), `value`, `duration` (`once`, `repeating` with `months`, `forever`), optional `products[]`; amount coupons apply once per eligible invoice, capped at covered positive charges, and support product restrictions and repeating/forever duration |
| `promotion.create` | a person with approval | `code`, `coupon`, optional `max_redemptions`, `expires_on`, `first_time_only` |
| `trial.extend` | owner, finance | `subscription`, `days` (1-90) on a running, unbilled trial; the first charge moves with the end date |
| `trial.collection.prepare` | owner with fresh factor | `subscription`; freeze the first advance invoice, verified saved card/account, exact amount and end date; no charge |
| `trial.collection.confirm` | preparing owner with fresh factor | exact returned `instructions.confirm`; another active owner/finance approves, or explicit `confirm_single` if none exists |
| `trial.collection.approve` | different owner/finance with fresh factor | `request`, `basis_hash`, `decision`; only the exact owner-confirmed terms |
| `trial.collection.revoke` | owner with fresh factor | `request`; only before the durable payment claim |
| `currency.rate.record` | owner with fresh factor | `currency` (CAD/EUR/GBP), `rate_date`, positive exact `usd_per_unit`, `source`; append-only, no carried-forward or invented rate |
| `trial.resolve` | a person with approval | `subscription`; at or after the end date a trial with a payment method converts and one without ends unpaid (the daily job does this too) |
| `amendment.propose` / `amendment.decide` | finance / a person with approval | `subscription`, `kind`, `value`, `effective_from`, `effective_to`, `price`, `note`, `clause` / `amendment`, `decision` |
| `change.prepare` / `change.decide` | finance / a person with approval | `subscription`, `item`, `price`, `quantity`, `effective_date` / `change`, `decision` |
| `subscription.end` | a person with approval | `subscription`, `end_date` |
| `subscription.pause` | a person with approval | `subscription`, exact `revision`, `effective_date`, `resume_date`, `access` (`retain`/`suspend`), `reason` |
| `subscription.resume` | a person with approval | `subscription`, exact `revision`, `pause` transition id, earlier `effective_date`, `reason` |
| `subscription.cancel` | a person with approval | `subscription`, exact `revision`, `mode` (`immediate`/`term_end`), optional `effective_date` (business-local today), `reason` |
| `subscription.reactivate` | a person with approval | `subscription`, exact `revision`, `effective_date` inside the cancellation’s saved inclusive window, `reason`; current meter ownership is checked |
| `lifecycle.policy` | owner | `credit_unused` boolean, `reactivation_days` integer (0–3650); prepares an exact policy request for `policy.decide` |
| `usage.submit` | owner, finance, `usage` credential | `events: [{event_id, customer, meter, quantity, occurred_at}]` (up to 5,000; times ISO 8601 with an offset) or a CSV `file` |
| `usage.control` | owner, finance, `usage` credential | `customer`, `meter`, `day` (billing timezone), `expected_count`, `expected_quantity`; identical submissions change nothing |
| `usage.acknowledge` | a person with approval | `control`, exact `basis` from `usage/inspect`, `reason`; any later event or source change invalidates acknowledgement |
| `billrun.prepare` | owner, finance | `period` (`YYYY-MM`) |
| `invoice.approve` | a person with approval | `invoice` or `run`, `acknowledge` when exceptions are listed |
| `invoice.finalise` | a person with approval | `invoice` or `run`, optional `issue_date` |
| `credit.issue` | a person with approval | `invoice`, `amount`, `reason`; above the owner threshold, use a prepared request and a different approver |
| `credit.policy` | owner | `two_person_above` (decimal dollars; empty disables the threshold), optional `balance_application` (`manual` or `automatic`); prepares a policy request |
| `credit.prepare` | a person with approval | `invoice`, `amount`, `reason`; returns `request` against the current balance and policy |
| `credit.approve` | a person with approval | `request`; above the threshold, the approver must differ from its preparer |
| `writeoff.issue` | a person with approval | `invoice`, `amount`, `reason`; at or below the owner's `credit.policy` threshold one person executes, above it use `writeoff.prepare` and a different approver. Posts the bad-debt journal and returns `posting` |
| `writeoff.prepare` | a person with approval | `invoice`, `amount`, `reason`; returns `request` saved with the exact balance, amount, reason, accounting effect and policy revision |
| `writeoff.approve` | a person with approval | `request`; above the threshold the approver must differ from its preparer; a changed balance or policy is refused (`write_off_stale`) |
| `writeoff.recover` | a person with approval | `write_off`, `payment`, `amount`; allocates a recorded payment to the invoice and reverses that part of the bad debt |
| `revenue.close` | a person with approval | `period` (`YYYY-MM`); closes that month, freezes its packet and posts its journals |
| `balance.goodwill` | a person with approval | `customer`, `amount`, `reason`; at or below the threshold one person executes |
| `balance.return` | a person with approval | `customer`, `payment`, `amount`, `reason`, `reference`; returns unallocated cash and records the transfer the business sent |
| `balance.prepare` / `balance.approve` | a person with approval | `kind` (`goodwill` or `return`) plus the same fields / `request`; above the threshold a different approver executes |
| `balance.apply` | a person with approval | `invoice`; applies goodwill then oldest cash |
| `ledger.post` | a person with approval | optional `posting`; retries pending QuickBooks postings once each and adopts an entry the ledger already holds |
| `payment.record`, `payment.allocate` | owner, finance | `customer`, `amount`, `received_on`, `method`, `reference`, `evidence` / `payment`, `invoice`, `amount` |
| `reminder.prepare`, `reminder.approve`, `reminder.discard`, `task.create`, `task.complete` | owner, finance (approve and complete: a person) | `customer` / `notice`, `recipient`, `subject`, `body` / `task`, `outcome` |
| `proposal.create` | owner, finance, `prepare` credential | `kind`, `title`, `payload`, `evidence` (below) |
| `proposal.decide` | a person with approval | `proposal`, `decision` (`approved`, `rejected`), `note`; collections may set `recipient`, `subject`, `body` |
| `import.preview`, `import.apply`, `import.job` | owner, finance (a person) | see [IMPORTING.md](IMPORTING.md) |
| `subscription.adopt` | owner | `subscription`, `cutover_start`, `acknowledge_unreconciled` |
| `access.give`, `access.end` | owner | `email`, `name`, `role` (`finance`, `accountant`, `collections`, `sales`, `support`, `developer` or `custom` with `custom_role`) / `member` |
| `role.define`, `role.update` | owner | `name`, `capabilities[]` / `role`, `revision`, `capabilities[]` — custom roles combine `read.customers`, `read.catalog`, `read.subscriptions`, `read.invoices`, `read.payments`, `read.reports`, `export`, `notes`, `receivables`, `draft`, `credits.limited`, `propose`; a change applies on each member's next request |
| `credential.issue`, `credential.revoke`, `credential.version` | owner, developer | `name`, `scopes[]` / `key` / `key`, `api_version` |
| `credit.issue` (support) | support or a custom role with `credits.limited` | `invoice`, `amount`, `reason`; at most the support credit limit set through `credit.policy` `support_limit` (zero until set) |

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

## Invoice terms and fields (`INV-004`, partial)

`business.configure` accepts optional `invoice_fields`, a name/value object for business-wide invoice fields. `customer.create` and `customer.update` accept optional `invoice_settings`; omission preserves the saved settings on update, and an object replaces them. For example:

```json
{
  "invoice_settings": {
    "paymentTermsDays": 45,
    "poRequired": true,
    "poNumber": "BUYER-42",
    "memo": "Please quote our purchase order.",
    "customFields": { "Cost center": "Research West" }
  }
}
```

Customer terms accept 15, 30, 45 or 60 calendar days after actual issue, or null to inherit the business default. Required PO may be saved empty while unresolved; recurring and standalone approval/issue then refuse it as a blocking `po_required` exception. Each business/customer field map has at most twenty names (1–80 characters) and string values (up to 500); the customer's value wins an identical business field name. PO is at most 120 characters and memo at most 1,000.

The resulting `calculation.inputs.invoiceContent` is included in the draft fingerprint and retained on the issued invoice and bill-run JSON export. New settings invalidate pending approval inputs, so prepare again; issued calculation inputs and due dates never change. Existing issued invoices without these inputs do not gain a reconstructed snapshot. Current rendering is operator review; branding/remit-to, hosted/PDF/email and hidden customer usage detail remain open.

An AGENT-006 setup may include `invoice` with the same settings plus a required exact source `quote`. The reviewer sees each quoted setting, unresolved PO or mismatched source terms prevent approval, and a different human approver installs the settings with the setup in one transaction. Every service-period preview returns `assumedIssueDate` (the service-period end), `dueDate` and `invoiceContent`; issuing then gives those same figures and content. Issuing later moves the due date by the same calendar-day difference.

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

## State exemption certificates (`TAX-002`)

`customers/ID` includes state exemption claims, certificate metadata and reminder history. Documents download privately from `/app/certificates/ID`. The operator collects and an approver validates the document, identity, state and dates; Nectar records this attestation, not an automated legal certification. Once any state is claimed for a customer, only a validated certificate covering the entire service period exempts that state; other states are taxable. A missing or expired claimed document blocks invoice approval. Certificate evidence is fingerprinted with the calculation, so a changed basis invalidates approval and issued evidence never changes. The original reference-only exemption remains the `NEC-02` mode for customers without state claims.

After the owner enables certificate mail, the daily 14:00 UTC cron checks dates in the billing timezone, requests missing/expired documents and sends one reminder within 30 days of expiry. It uses configured Base mail. Status distinguishes provider acceptance, local suppression and failure/uncertainty; acceptance is not mailbox delivery. Sending/uncertain records stay visible for investigation rather than risking duplicate notices.

## Credit approval slice (`GOV-002`, partial)

The owner sets the credit threshold on an issued invoice. A direct `credit.issue` above it refuses even for the owner. `credit.prepare` saves the amount, reason, preparer, balance and policy revision; `credit.approve` requires another person above the threshold, rechecks the exact balance and policy, and atomically issues one numbered credit and closes the request. A duplicate, changed balance or changed policy refuses; prepare a new request. Credits at or below the threshold still need one authorized person. Refunds and write-offs remain outside the completed governance slices; price and policy approval doors are described below.

## One-time and standalone billing (`CAT-006`)

Add a charge on a customer record, choosing an immutable catalogue price or entering a custom total. Charges linked to a subscription join its next draft; other charges wait for a standalone invoice. Select pending charges and call `invoice.manual` to bill immediately, including a charge linked to a subscription. The standalone invoice has no subscription and uses the normal `invoice.approve` and `invoice.finalise` doors, numbering, declared tax, certificate checks, credits, payment allocation and exports. Custom amounts are approved with the exact invoice inputs before issue. For a standalone invoice, its issue date may start on the service date.

Charge records never change. Issue consumes them in the same transaction as numbering, so another prepared draft cannot bill them again, and immediately billed charges disappear from later recurring drafts. A price retirement does not rewrite a queued charge. The new calculation rule version records one-time lines while unchanged recurring inputs retain their prior rule version. `customers/ID` includes charges and the invoice that consumed each one.

`subscription.addon` requires a named approver, rejects overlaps, retired prices, previous-biller periods and already-issued recurring periods, and records the effective date. The ordinary rating engine prorates the new fixed or seat item and records its exact evidence.

For a member-prepared `price_change` proposal, `proposal.decide` requires a different member for approval, including when the preparer is the owner (`second_approver_required`, 409). Rejection is still available to the preparer. `proposals/ID` exposes `needsOtherApprover` and `needsPreparation` for the current actor. Existing member-prepared price proposals without a saved member identity cannot be approved (`price_proposal_needs_preparation`, 409); reject and prepare again. An agent can prepare but never approve. This rule covers price-migration proposals; the remaining price doors are still part of GOV-002 work.

`GOV-002` also applies to `price_override` amendments through `amendment.decide`, subscription-creation exceptions and member-prepared amendment proposals, and to `change.decide` when `new_price_id` differs from the original item price. The saved preparer cannot approve; another authorized person must. Rejection/discard is still available to the preparer. A legacy pending override or switch without a saved identity refuses approval (`price_override_needs_preparation` / `price_switch_needs_preparation`, 409); prepare it again. Quantity-only changes keep their existing single-person approval. Catalogue revision approval is described below.

Policy preparation doors `credit.policy`, `certificate.policy` and `tax.declare` now return `{request,status:"pending",kind,payload}` without changing active settings. Read `policies` for pending requests and history, and `policies/current` for current credit/reminder settings. POST `policy.decide` with `request` and `decision` (`approved` or `rejected`). A different active owner or finance approver applies the exact stored values. A changed policy revision refuses (`policy_changed`, 409). The preparing owner can confirm alone only when no other active owner/finance approver exists, using a second request with `confirm_single:true`; history and audit record `single-approver`. Without that flag it refuses (`single_confirmation_required`, 409); if another approver exists, self-confirmation refuses even with the flag. Applying a tax declaration clears its owner review; `tax.review` remains the separate owner attestation required before invoice finalisation.

`price.create` publishes a product's first price (v1) and returns `{id,version}`. Later versions return `{request,status:"pending",version}` without creating an active price. `catalog.priceRequests` contains the exact normalized terms, status, stale flag and `singleAllowed` for each saved request. POST `price.decide` with `request` and `decision` (`approved` or `rejected`) to publish or reject. A different active owner/finance approver publishes; if no other active approver exists, the preparing owner must send a separate explicit `confirm_single:true`. Approval returns the new price `id`, `version` and recorded `mode`. A published competing version refuses (`price_request_stale`, 409), and repeat decisions refuse (`price_already_decided`, 409). Caller-supplied replacement terms cannot change the saved request. Both modes record immutable history and audit; pending requests protect imported products/meters from move-in undo.

## Reports and calculation sources (`RPT-003`)

`GET /api/nectar/reports/{metric}` accepts `mrr`, `billings`, `ar` or `collections`, optional `period=YYYY-MM` and `customer=<id>`. AR is always current; its optional `bucket` is `current`, `1-30`, `31-60`, `61-90`, `90+` (URL-encode `+`) or `overdue`. Responses publish their definition, period, integer-cent total, source entries and operator-screen links. All doors require the read capability.

`GET /api/nectar/reports/{metric}/{id}` returns the contributing invoice's signed lines, tax, actual credits and allocations as appropriate. Collections IDs name recorded payments: components are real invoice allocations plus the unallocated remainder, with the original payment evidence. No processor settlement is implied. A noncontributing or filtered-out source is refused.

`GET /api/nectar/invoices/{invoice}/lines/{line}` returns the issued line, parsed evidence, original saved invoice inputs, fingerprint and rule version, and that line's exact saved usage events and quantity sum. The invoice/line/customer relationship is checked. Fixed lines have no usage events; their related metered lines are linked. Later event ingestion or correction does not rewrite the saved calculation. Equivalent pages are under `/app/reports/...` and `/app/invoices/{invoice}/lines/{line}`.

Billed MRR sums issued monthly flat, seat, current-period usage and recurring discount lines by the subscription-period start month, including actual proration; it excludes late usage, one-time fees, fixed credits, credit notes and tax. It is a billed snapshot rather than normalized run-rate MRR. Billings includes original lines and tax by invoice issue month. AR includes current owed balances without allocating payments to lines. Collections includes recorded external receipts in the selected month up to today in the business timezone, and makes each unallocated remainder explicit.

## Invoice lists and expansions (`DEV-002`)

`GET /api/nectar/invoices?limit=100&customer=ID` returns `{data,next_cursor}` (`nextCursor` under version `2026-10-01`) for issued invoices only. `limit` is 1–100 (default 100); customer is optional. Follow with the identical query and `cursor=<URL-encoded next_cursor>` until it is null. Invalid cursors/limits or a cursor used with a changed customer/limit are refused. The first request snapshots the immutable invoice-issuance journal. Subsequent pages stay in issuance order within that snapshot, so an invoice issued between requests is excluded even if its draft existed before the first page or its invoice date is backdated. Start a fresh list to include it. All requests enforce the ordinary read capability independently.

`GET /api/nectar/invoices/ID?expand=customer,lines.price` returns the customer object in `customer` and immutable price objects in each line's `price`. Without expansion those relationship fields contain ids; a line without a price has null. Expand either relationship independently; unknown paths are refused with `unknown_expansion` (400). Existing `customer_id` and `price_id` fields remain available. The saved calculation, original line amounts and fingerprint are unchanged.
## OpenAPI, idempotency keys, versions and list cursors (`DEV-002`)

- **OpenAPI.** `GET /api/nectar/openapi` returns the OpenAPI 3.1 document for every read door and action to any signed-in member or credential. Each action's body fields are generated from its handler (`node scripts/api-fields.mjs` rewrites `src/nectar/api-fields.ts`; `--check` fails when it is stale).
- **Idempotency keys.** Send `Idempotency-Key: <1–255 printable characters>` with any JSON write. The key belongs to the calling member or credential. Repeating the identical request (same action, version, content type and body) within 24 hours returns the first successful result with `Idempotent-Replayed: true` and runs nothing. A different request under the key answers `409 idempotency_key_reused`; a repeat while the first is still running answers `409 idempotency_in_progress`. A failed write releases its key. Stored results are discarded after 24 hours, are never carried by archives or restores, and a GOV-005 erasure redacts the erased customer's personal values from them.
- **Dated versions.** `2026-10-01` is the original shape; `2026-10-20` (latest) names list continuations `next_cursor` (was `nextCursor`). `credential.issue` takes optional `api_version` (default the latest); credentials issued before versions existed are pinned to `2026-10-01`; the owner repins one with `credential.version` (`key`, `api_version`), audited. `Nectar-Version: <date>` answers one call under that version; members' sessions use the header or the latest. An unknown version answers `400 unknown_api_version`. Every answer carries a `Nectar-Version` response header.
- **List cursors.** Every list door (`customers`, `payments`, `runs`, `proposals`, `audit`, `members`, `roles`, `credentials`, `usage/batches`, `notices`, `tasks`, `policies`, `imports`, `shadow`, `erasures`, `note-members`, `notes/KIND/ID`, `objects/KIND`) accepts `limit` (1–100, default 100) and `cursor`, returning `{data, next_cursor}`; without either it returns the whole list. The cursor continues after the last returned row in the list's current order and binds the path and page size; rows placed before it appear only in a fresh listing, and a cursor whose row has left the list answers `409 cursor_stale`. Other doors refuse paging with `400 not_a_list`.

## Customer notes (`CUS-002`)

`POST /api/nectar/note.add` accepts `kind` (`customer`, `invoice`, `payment`), `record` (the internal record id), `body` (1–4,000 trimmed characters) and optional `mention` (an array of up to 20 distinct active member ids). A signed-in owner or finance member records the note; customer ownership is resolved from the target record, never a caller-supplied customer. The result is `{id: customerId, note: noteId}`. Notes have no update/delete door: add a follow-up. Supplying an id or customer override is refused.

`GET /api/nectar/notes/{kind}/{record}` reads the record's notes. `GET /api/nectar/customers/{id}` includes every note on that customer, its invoices and payments. Both use the existing read capability. `GET /api/nectar/note-members` lets a member with the records capability select active mention recipients. Each note records the server timestamp and author; mention outcomes distinguish provider acceptance, local suppression, failed delivery and uncertain delivery. An uncertain attempt is not automatically retried. Notification links open the signed-in customer or invoice page; payment notifications name the payment reference and link to the customer's notes.

`GET /app/exports/customers.csv` requires export capability and contains customer billing details plus `notes_json`, including note contents, author/date, record identity and mention outcomes. Existing installation archives retain both new domain tables through the ordinary export/import path. Operator customer/invoice pages provide the same append-only forms, and customer pages include a payment-note form for each listed payment.

## Live usage and upcoming invoices (`USE-006`)

`GET /api/nectar/subscriptions/ID/upcoming` requires the existing read capability and defaults to the anchor period containing today in the business timezone. Optional `period=YYYY-MM` chooses the period starting in that month. Invalid months are refused; periods outside the subscription's service dates or owned by the previous biller are refused. Reads write nothing and are never cached.

The response contains exact current-period meter quantities/event ids, earlier unbilled quantities/event ids separately, unused approved one-time contract credits and their applicability dates, and `calculation` with the bill-run engine's exact inputs, lines, tax, exceptions, rating version and fingerprint. Fixed charges cover the full service period while usage includes recorded inputs only, with no forecast of future ingestion. Draft source reconciliation is included. Later input changes produce a new fingerprint and invalidate any older approved bill draft as before. `remainingContractCreditCents` names one-time contract credits, not prepaid credit balances.

An already issued selected period returns `state:"issued"`, its invoice id and immutable saved calculation rather than re-rating unbilled events as a second invoice. Shadow subscriptions return `state:"shadow"`, never an issuable preview. The subscription screen has the same current calculation, a month selector, live usage and approved credits; the Usage screen links each subscription-period to it. Portal parity belongs to PORT-002 and prepaid balance parity to CAT-004 before either ships.

`GET /api/nectar/customers/ID?preview_period=YYYY-MM` also includes `upcoming`: one row per own subscription with its separate anchor period, state (`preview`, `shadow`, `issued` or `unavailable`), exact subtotal/tax/total cents, review exceptions, remaining approved one-time contract credits and a `sourcePath` to the original calculation. Omit the month or leave it empty for each subscription's current business-local anchor period. Issued rows retain saved inputs; outside-service and previous-biller periods have null amounts and an explicit reason. This composition requires the existing customer, subscription and invoice read capabilities; other customer readers receive `upcoming: null`. Erased customers have no preview. The customer screen uses the same rows and month selector. Reading never prepares, approves or issues an invoice and does not combine different subscription periods into a forecast. CUS-001 remains partial for its other record requirements.

## INT-003: team email choices

A signed-in member (including an accountant) reads `GET /api/nectar/notifications` and replaces their own choices with `POST /api/nectar/notification.preferences`: `mentions`, `payment_mismatch`, `billrun_exceptions`, `proposals` are booleans. The HTML form on More uses the same handler. No member-id override is accepted; credentials cannot read or change these choices. Mentions start enabled to preserve existing CUS-002 behavior; the other categories start disabled.

Manual payment mismatch means the customer has an issued invoice with a positive current balance and the payment amount equals none of that customer's current invoice balances (after credits and allocations). Drafts and fully settled customers do not trigger it. The payment's alert links to its exact anchor on the customer record. A prepared run with any exception links to that run; a newly pending proposal links to that proposal. The current owner and finance roles receive these three categories only when opted in and still active/authorized. Accountants receive permitted mentions only. New alerts carry the event label and signed-in link, without financial amounts or record content; mention mail retains the note.

The originating write queues each event/member pair atomically. Delivery claims it once, rechecks the member and preference, and records provider acceptance/reference, development suppression, rejection, failure or uncertainty. `accepted` means provider acceptance, never mailbox delivery. Pending unclaimed alerts resume on the scheduled handler; accepted/rejected/failed/uncertain or interrupted `sending` claims never automatically retry. `GET notifications` returns only the caller's recent alert receipts. Mention receipts remain on the note itself. Dispute and webhook-failure event categories remain obligations of AR-003, PAY-004 and DEV-001 before those event capabilities ship.

## DEV-005: metadata revisions

`GET metadata/{kind}/{id}` returns the current map, revision, append-only history and original-record link. Kinds are customer, subscription, price, invoice, payment and credit-note. `POST metadata.write` takes `kind`, `record`, the current numeric `revision` (zero initially), and `metadata`, an object of at most 50 string pairs. It replaces the complete map, keeping every earlier map with server author/time. Keys and values remain exact, including empty keys, whitespace and Unicode. A stale revision returns 409; malformed or oversized maps return 400 without writing. Only owner/finance members with records authority write; accountants and prepare credentials read. Metadata never enters rating inputs or edits immutable financial rows.

`GET objects/{kind}?metadata_key=...&metadata_value=...` lists records whose latest map contains that exact key and string value. The same filter works on `/app/exports/objects/{kind}.csv`; all six kinds have this CSV. Customer/catalog/payment lists and existing customer/subscription/invoice CSVs also support the filter, and original API records project metadata plus metadata_revision. `GET customers?search=...` searches current values on customer-owned record kinds and subscribed prices, as well as customer name/id/email, by case-insensitive substring. Search never uses superseded metadata. The customer screen exposes that search; record screens and Exports link to metadata editors and the collection browser.

The portable installation archive retains every metadata revision. DEV-003 inherits SDK parity and DEV-001 inherits event-time metadata copies in invoice.paid and other relevant payloads before those capabilities ship.

SUB-003 lifecycle dates use the business timezone and [start, end) intervals. Subscription detail includes append-only `lifecycle`, derived `intervals` and current `lifecyclePolicy`; the subscription CSV includes `lifecycle_json`. Pause bills neither paused service nor paused usage; earlier unbilled usage/fees and contract credits are deferred to resumed service. Cancellation of current in-arrears plans shows full recurring charges less a signed `cancellation_credit` computed from exact earned lines, including discounts; tax uses those signed lines. The existing credit threshold requires another person to approve and issue an invoice above the limit. The saved calculation includes the policy revision, so policy changes invalidate approval. No-credit policy retains the final recurring period, while a later reactivation month only bills active days. Dates touching issued periods are refused. Policy edits use the existing two-person or explicit sole-owner confirmation journal. Future advance-billed cancellations, customer balances and processor refunds remain CAT-001/INV-005/INV-006/PAY-007 obligations.

CAT-007 `price_change` proposals accept `target_price` for an exact active immutable catalogue version (product is inferred; `source_price` optionally limits affected items), or the existing new-simple-price fields. All matching kind/meter items in each selected subscription migrate together; other items and unselected subscriptions are retained. `effective_date` is a business-local date and `timing` is `date` (default) or `renewal`. Renewal means the first monthly anchor on or after the reference, inclusive. Nectar computes `resolved_dates` itself and saves each impact entry’s `effective_date`, subscription label and two invoice previews; caller-supplied resolved dates never control preparation. Approval uses saved dates and exact rating input fingerprints, refuses changed inputs or issued periods, and creates no price copy for an existing target. GOV-002 approval remains mandatory. Future annual-term eligibility/renewal/grandfathering and optional customer notices remain CAT-001/INV-002 obligations.

### Signed commitments and ramps (CAT-003)

`POST contract.prepare` takes `subscription`, exact `revision`, quoted `clause`, and arrays `commitments`, `included`, `ramps`. A commitment has business-local exclusive `from`/`to`, dollar `minimum`, boolean `taxable`. Dates align to the subscription anchor; each explicit window may cover one or several monthly invoice periods. An allowance has `price`, decimal `quantity`, `from`, `to`; it resets each original monthly period and never repeats on late ingestion. A ramp has original `item`, `effective_date`, immutable target `price`, integer `quantity`; all steps for one original item are supplied together. Price kind/meter must match. Preparation returns `{id,contract}` and changes no billing.

`POST contract.decide {contract,decision}` approves or rejects. Only a different active member with approval authority approves; credentials/accountants cannot prepare or decide. Approval checks the saved subscription revision, active compatible prices and issued-period guards, then applies all dated item segments atomically. Approved/rejected signed terms never change. Subscription detail exposes `contracts` and `burnDown`; subscription CSV includes their JSON. Each burn-down window links all issued invoices, with exact earned/true-up contributions. `minimumCents` is the active-day-adjusted minimum; `nominalMinimumCents` preserves the signed amount. `billedCents` is eligible earned plus true-ups, before tax/unrelated fees/credits. Customer portal parity remains PORT-002.

Minimum burn includes fixed/seat/usage after percentage discounts and unused-service cancellation credits; one-time fees/fixed contract credits and other minimum true-ups are excluded. Minimums are reduced for trial/pause/canceled days using calendar-day proration, rounded half away from zero. A positive shortfall is a `commitment_trueup` on the final window invoice (or cancellation final period), with prior issued inputs fingerprinted. Missing earlier monthly invoices block approval. Prior true-ups reduce later settlement after reactivation. Included units are applied chronologically once per price/original period; late usage gets only the unconsumed original allowance. `overage` lines retain `rawQuantity`, `includedQuantity`, `billableQuantity` and original events. Every final line rounds once to cents, before tax.

### Billable metrics and dimensions (USE-002)

Raw `usage.submit` events optionally carry `properties`, up to 30 scalar pairs, with identifier keys up to 60 characters and strings up to 500. Booleans, null and safe integer numbers retain their types; decimal property values use exact strings. Property order does not change replay identity, changed values do. CSV accepts/exports `properties_json`; omitted/empty properties preserve published property-free replay identity. Ingestion accepts source-stream meter codes, never a derived metric version.

`meter.prepare {code,name,unit_label,source_meter,definition}` returns `{request,version}`. Definition fields: `aggregation` (sum, count, maximum, unique, latest, time_weighted), `group_by` (0–5 property names), optional `value_property` (defaults to event quantity), `unique_property`, `entity_property`, `time_unit` (hour/month), and `filters:[{property,operator,value}]`. Filters AND scalar comparisons (`= != < <= > >=`). Or supply `sql` instead of `definition` for the supported grammar below. `meter.preview {request,customer,period}` evaluates a full past calendar month in the business timezone and saves `{preview,period,fingerprint,results}`; each result retains typed `dimensions`, six-place display `quantity`, exact `{numerator,denominator}`, selected `eventIds` and predecessor `contextEventIds`. `meter.activate {request}` requires current records-member authority plus three unchanged distinct month previews for one customer. It atomically activates a new immutable meter with code `code.vN`, returning `{id,code,version}`. Source changes or competing version activation refuse. Catalog exposes requests, previews and immutable meters; read members/prepare credentials can preview, while usage credentials cannot.

A unit `price.create` binding an advanced meter requires `dimensions` with exactly its group-by keys and typed scalar values. Each price keeps its exact meter version. All selected metrics and model prices for a customer's source stream must share its owning subscription; duplicate overlapping version/dimension selections and another subscription's claim refuse. Add-on/reactivation enforce the same boundary. Unit overrides and dated item changes use the actual active intervals; trial/pause/cancellation contribute zero. Included units and all four existing quantity pricing models use the metric's exact rational, never its rounded display. `metric_usage` evidence retains dimensions, aggregation, raw/billable exact quantities, source id, version, plan, active intervals, raw ids and predecessor context. Inspection/upcoming/invoices/report drill-down and CSV preserve these facts.

SQL accepts one aggregate and its projected group keys from `usage_events`: `SELECT properties.model, SUM(CASE WHEN properties.weight >= 1 THEN quantity * properties.weight / 2 ELSE quantity END) AS quantity FROM usage_events WHERE properties.region IN ('us','ca') AND NOT properties.active != true GROUP BY properties.model`. Aggregates: SUM(expression), MAX(expression), COUNT(*), COUNT(DISTINCT properties.key), LATEST(quantity), TIME_WEIGHTED(quantity,'hour'|'month'[,properties.entity]). Expressions support decimal literals, quantity, numeric properties, unary minus, `+ - * /`, parentheses, and CASE WHEN/THEN/ELSE/END in SUM. WHERE supports `= != < <= > >= IN NOT AND OR`, with SQL-like unknown for missing/null operands. Only approved columns/properties/functions are parsed; statements are never executed against D1. Writes, joins/subqueries, schema access, multiple statements and unknown syntax fail. One optional trailing semicolon is accepted.

Sum/count aggregate selected events; maximum/unique/latest operate per original period, latest using greatest `(occurred_at,event_id)`. Unique excludes missing/null and distinguishes number 7 from text "7". Missing grouping values share the null group. Time-weighting holds the latest state per entity, starts at zero without a predecessor and resets to zero at a filtered-out snapshot. A month divides by actual period milliseconds (including DST); an hour is 3,600,000 ms. Exact rational money rounds once, half away from zero, per line. Late nonadditive events raise blocking `metric_late_correction` linked to original ids; historical delta/credit execution is inherited by USE-004 rather than treating late snapshots as a fresh charge.

Exact negative aggregate results remain visible in saved previews. Billing adds blocking `metric_negative_quantity`, with exact signed result and original ids; it leaves that invalid quantity unrated and refuses invoice approval until corrected, even when other positive lines would hide the negative. It never clamps a quantity or issues an ungoverned credit. Correcting the source/definition permits fresh preparation against a new fingerprint. USE-004 retains governed historical credit-note execution.

### Historical pricing simulation (AGENT-004)

POST `proposal.create` with `kind: "price_change"` and payload `{ "simulation": true, "subscriptions": ["subscription-id"], "start_month": "2026-01", "effective_date": "2026-07-01", "source_price": "old-price-id", "target_price": "active-target-id", "cost_cents": 500 }`. Exactly six consecutive issued monthly service periods are required per selected subscription (up to 200 unique ids). Target-seat `quantity` is an integer; it defaults to each original seat quantity for seat-to-seat and is required for another kind to seat. `cost_cents` is optional, assumed per subscription period, and margins are estimates. Native and metric source usage, including billed events and predecessor context, is replayed through the rating engine; signed price-specific terms keep their original bindings.

Read `proposals/{id}` for per-invoice saved before/after lines and cents, source events/fingerprints, six-period totals, most-affected customers, estimated margins, exact future previews and prepared cited customer notices. Member records authority or a prepare credential creates; an active approval member calls `proposal.decide`. A member-prepared change needs a different approver. Approval rechecks all source bases, atomically schedules only the saved cohort/date/quantities, and preserves the original evidence and notice. This door sends no customer email; INV-002 retains delivery. Unsupported future billing intervals/terms stay in CAT-001.

## Executed-order setup (AGENT-006)

Prepare `proposal.create` with `kind:"amendment"`, `payload.setup:true`. The external prepare agent supplies `source:{name,text,execution_reference,original?:{filename,type,base64}}` (original file at most 256,000 bytes), `customer` (existing `id` or new `external_id,name,billing_email`), `catalog` (stable `key`, existing price `existing` or `new_product:{code,name}`/existing `product`, ordinary price fields), `subscription` (new `start_date,anchor_day` and exactly one `end_date`, positive calendar `months`, or `evergreen:true`; existing `id,effective_date`), and quoted `items`, `commitments`, `included`, `exceptions` or existing-item `ramps`. Each mapped row requires an exact nonempty source `quote`. Exceptions are `discount_percent` (recurring flat/seat charges, as in ordinary billing), `fixed_credit` (once at its effective date), `price_override` (simple price only). Windows use business-local dates and exclusive ends; commitment/included windows align to the monthly anchor. Input is retained unchanged.

The proposal contains first/full-term real-engine previews and source custody. Explicit `usage_assumptions:[{period,meter,quantity}]` need `usage_scenario_label`; these are additional hypothetical usage and never ingested. Unknown future usage is excluded, not predicted. Finite terms preview all service periods; evergreen previews 36 with the explicit renewal limitation. Original file/text download: `GET proposals/:id/source` under ordinary read authority. Signature execution is buyer-recorded, never verified by Nectar.

Unresolved `ambiguities:[{issue}]` and unsupported requirements block approval. A records member submits `setup.resolve` with `proposal` and repeated `resolution` values through the ordinary form/API door: this appends a revised immutable-source proposal; it does not mutate the original. Normal `proposal.decide` requires a separate active human approver for a member preparation, refuses stale bases and applies the setup atomically. Invoice approvals remain ordinary separate decisions. SET-001/CAT-001/INV-004 retain future entity, interval and PO/payment-term support.

### Financial reports (RPT-002)

`GET reports/{mrr,billings,collections,ar,credits,tax,unbilled}` takes `period=YYYY-MM` and optional `customer=ID`; AR also accepts `bucket=current|1-30|31-60|61-90|90+|overdue`. Each report returns its exact definition, integer-cent total and source contribution links; `GET reports/METRIC/SOURCE` opens the matching calculation/ledger evidence. Credits use actual business-local creation month, tax is original issued tax without invented credit attribution, and unbilled is usage-only engine rating of begun live unissued periods, including snapshot continuation through the service period. All reads require record-read capability. `GET /app/exports/reports/METRIC.csv` uses the same filters, requires export capability and protects spreadsheet formulas.

Humans with export authority use `POST report.schedule {enabled:boolean,day:1..28}` to choose their own monthly report (default off), `GET report-schedule` to read their schedule/outcomes, and `GET report-deliveries/ID` to read only their own frozen reports/source evidence. Unknown recipient/member fields are refused. `/app/report-schedule`, `/app/report-deliveries/ID` and `/app/report-deliveries/ID.csv` are the corresponding signed-in screens/download. The daily scheduled handler reserves the previous-month report on or after the chosen business-local day, freezes current records/AR and source evidence, rechecks active authority and opt-in, then sends figures/definitions with an authenticated snapshot link. Provider acceptance does not prove mailbox delivery; claimed/uncertain sends are never automatically retried.

### Reviewed corrections and customer explanations (AGENT-002)

Prepare an issued-invoice credit with `proposal.create {kind:"amendment",title,payload:{invoice_credit:true,invoice,amount,reason,explanation,subject,body,citations:[{line_id,source,quote}]}}`. Each citation names that invoice's saved line path (`/app/invoices/ID/lines/LINE`, optionally `#evidence` or `#calculation`) and quotes actual saved source text. Nectar recomputes original subtotal/tax/total and the exact unpaid-balance reduction; issued evidence and original tax remain unchanged. The recipient is fixed to the current billing email, and approval uses the immutable saved wording. Above the owner credit threshold, `proposal.credit.prepare {proposal:ID}` creates the proposal-bound ordinary GOV-002 human request; a different authorized human uses `proposal.decide` to approve. The bound request cannot execute through standalone `credit.issue` or `credit.approve`. Proposal details expose `correctionMail` and `creditRequest`; rejection, stale inputs and duplicate approval create no credit/message.

Ordinary amendment and unbilled `usage_correction` proposals retain their existing inputs and gain before/after engine tax, totals and exact input fingerprints. Nectar computes `payload.noticeDrafts` from their real affected subscriptions, usage sources and current billing recipients, ignoring caller-supplied drafts. `customerMessages` exposes frozen approved message outcomes. The adjustment, decision and mail reservation commit together; one provider attempt follows, with durable honest outcomes. Claimed or uncertain attempts are never automatically retried. Commercial price migrations and executed-order setup retain their separate AGENT-004/AGENT-006 flows. Unsupported future revenue schedules, normalized MRR, customer portal and attributed credit-tax effects remain explicit until their owning clauses ship.

### SUB-004 renewal terms

`term.prepare` saves `{subscription, revision, term_start, months, auto_renew, notice_days, uplift_percent, quote?}`. Terms start on the billing anchor, separate from monthly billing. Months: 1–120; notice lead: 1–365 days (automatic annual or longer: 15–45 inclusive); uplift: exact 0–100%. `term.decide` takes `{term,decision: "approved"|"rejected",confirm_single?}` under GOV-002. Preparation is inert. A different active approver confirms; the sole owner must explicitly confirm where GOV-002 permits. Replaced terms invalidate their links.

`term.link` takes `{term}` as an approval member and returns `cancelUrl` once, rotating any old link. The operator form is `POST /app/renewal-link`. Keep the URL private: it permits only canceling that subscription's next renewal. `GET /renewal/TOKEN` never mutates; its same-origin confirmation POST cancels renewal at the saved term boundary without signing in or calling. No customer identities or invoice data appear there.

Subscription detail exposes `renewal.terms`, immutable `renewal.events` and notice snapshots/outcomes, also in subscription CSV's `renewal_json`. Daily Cron uses business-local dates, applies each renewal once, compounds unit/tier monetary prices to six decimals half away from zero, and reserves one notice attempt before the mail edge. Notices retain scheduled date, exact quoted figures and accepted/rejected/uncertain/not-configured custody; uncertain sends do not retry and acceptance does not mean delivery. Original catalogue prices and issued evidence remain unchanged. New item prices start their own dated uplift history. Contract setup accepts quoted `subscription.renewal`; full-term historical simulation and catalog renewal migrations use the actual term length/boundary.

### SUB-005 cancellation saves and returns

`GET /api/nectar/retention` (read capability) returns the current policy, immutable policy requests and offer outcomes without bearer tokens. `/app/retention` exposes the same report and owner policy preparation. `retention.policy.prepare` requires owner and the current `revision`; `retention.policy.decide` takes `{request, decision, confirm_single?}` under GOV-002. Policy fields: `enabled`, `save_kind` (`discount`, `pause`, `downgrade`), integer `save_percent` 0–100, `save_months` 1–36, `pause_months` 1–12, exact `downgrade_source_price_id`/`downgrade_price_id`, `winback_enabled`, `winback_days` 1–365, `winback_percent` 0–100 and `winback_months` 1–36. Defaults are off, 50% for two save periods, and 30% for three return periods within 60 days.

Issuing a renewal cancellation link or its scheduled notice freezes one optional save. GET is read-only. Its one form offers either `confirm=cancel` with an optional reason (up to 500 characters), or `confirm=save` with that scoped offer id. Cancellation needs no offer acceptance or reason. Discounts cover fixed/seat charges in the current unissued monthly period and subsequent quoted periods, never usage or overlapping discounts. Pause suspends access and billing. A downgrade permanently splits every matching source-price item at the saved date, retaining original item end dates. Stale inputs, policy, prices or issued periods refuse changes.

Daily Cron reserves one win-back per ended subscription in the inclusive business-local window and records actual configured mail-provider outcomes without retries. `GET /return/TOKEN` shows only the offer; its exact-origin `confirm=accept` POST rechecks eligibility, source and meter ownership and atomically resumes service with the quoted discount, without billing inactive days. Tokens are hashed and die after use, expiry or policy replacement. Neither provider acceptance nor a downloaded/prepared offer is called mailbox delivery.

The public-door journey uses `h.advanceClock` on a disposable local installation. The `NECTAR_LOCAL_TIME` runtime binding is honored only in local mode; hosted billing uses real time. This test driver preserves D1 and ordinary auth and is not the future DEV-004 isolated processor sandbox.


## Cited billing answers (`AGENT-007`)

`POST answer.read` takes `customer`, an issued `invoice`, and `question`. It is read-only and requires record-read authority (owner, finance, accountant or prepare credential). The optional `topic` explicitly selects `total`, `comparison`, `seats`, `usage`, `events`, `tax`, `adjustments`, `commitment`, `balance` or `terms`; otherwise the deterministic interpreter identifies supported wording and refuses ambiguity or unavailable questions. Nothing is sent to a model provider.

The answer returns its interpreted topic, exact typed `figures` with a public `source` and RFC 6901 `recordPath`, and operator calculation citations. Comparisons default to the latest earlier issued period of the same subscription; `comparison_invoice` can explicitly select another issued invoice of that subscription. Derived differences retain their before/after operands and grouped line contributions. Customer/invoice/comparison mismatches return 404. Saved invoice inputs, prices, tax, terms and event snapshots remain the evidence after later changes.

Optional `credit_amount` (exact decimal dollars) and `reason` return a validated `proposalDraft` without writing. `POST answer.propose` takes those same fields, requires proposal authority, recomputes the source and saves only an ordinary pending AGENT-002 invoice-credit proposal. The explicit operator form has the same behavior. Original invoice amounts and tax remain unchanged; separate human approval, current recipient/source checks and GOV-002 controls remain mandatory. Unsupported questions return 400; signed-out and usage-only credentials receive 401/403.


## Transfer collections cadences (`AR-001`)

`GET cadences` returns the current policy, prepared policy requests, issued invoices with original balance, explicit disputed amount and collectible remainder, promises, disputes, reminder custody and owner escalations. Record readers may inspect; all collection mutations below require an owner/finance human with receivables authority. Prepare or usage credentials cannot mutate collection state.

- `cadence.policy.prepare` is owner-only: `enabled`, `require_human`, and ordered `rules: [{segment,minimum_cents,subject,body}]`. Minimums are integer cents; templates accept `{invoice}`, `{balance}`, `{stage}` and `{business}`. The exact current collectible facts and excluded dispute amounts are appended. The policy starts disabled.
- `cadence.policy.decide`: `request`, `decision` (`approved` or `rejected`), and explicit `confirm_single` only when the preparing owner has no other active owner/finance approver. Otherwise another approver is required.
- `cadence.enroll`: issued `invoice`, explicit `segment`, and operator-recorded `transfer_terms`. This records agreed terms, not verified payment details.
- `cadence.promise`: `invoice`, inclusive business-local `pay_date`, and evidence `note`. A new immutable promise retains the previous one.
- `cadence.dispute`: `invoice`, its positive `line`, `amount_cents`, and `reason`. Open disputes on that line cannot cumulatively exceed its original amount. No debt or tax is changed. `cadence.resolve` takes `dispute` and evidence `outcome`.
- `cadence.approve`: `delivery` and the exact frozen `recipient`, `subject`, `body`; source, holds and policy must still agree. HTML CRLF line endings normalize to LF after ordinary field trimming, with no other wording changes. It queues that reminder for the next daily tick or `cadence.run`.
- `cadence.run` executes due checks now; the real scheduled handler executes the same checks daily.

Stages use local dates −3/+1/+7/+15 relative to due date. A missed sequence selects only its latest eligible stage. Payments and credits reduce debt before explicit disputed cents are excluded; zero collectible balance or an inclusive promise prevents chase. Human approvals are invalidated by source/policy/recipient changes. The +15 stage assigns an owner task. Actual provider acceptance is never called delivery; claimed, terminal or uncertain sends are not automatically retried. Existing manual reminders and collection proposals honor the same holds.

### Historical usage corrections (USE-004)

`POST /api/nectar/usage.correction.preview` requires billing read authority. Send `subscription`, `from_period`, `through_period` (inclusive YYYY-MM), `void_event_ids` and `add_event_ids` (distinct string arrays, at most 10,000 each). The range must contain every issued recurring invoice for at most 36 monthly periods. Additions must already exist as unbilled usage for that customer and an original source meter. The response reproduces saved originals, replays the selected events with the original rating versions, prices, tax and predecessor context, and returns per-invoice before/after lines, exact signed deltas, fingerprints and citations. It is always unresolved and covers only the chosen range; downstream periods may need another replay. This action changes no billing records and cannot clear an issue block or authorize a financial disposition. The issued invoice links to the same preview at `/app/usage/replay`.

Financial actions use that same saved-source engine but replay the complete issued chain, including downstream periods beyond the read-only preview's 36-period limit:

- `usage.correction.policy`: owner prepares `disposition` (`next_invoice`, `correcting_invoice`, `credit_note`). Ordinary `policy.decide` applies the exact GOV-002 request.
- `usage.correction.prepare`: `subscription`, `from_period`, `through_period`, `void_event_ids`, `add_event_ids`, `reason` and authored `explanation`. Forms accept whitespace-separated `void_ids`/`add_ids`. The inclusive range must cover the earliest affected original period through the latest issued period. Returns a pending id, frozen plan and basis; preparation alone changes no financial totals.
- `usage.correction.authorize`: `correction`. A human with approval authority takes responsibility for an above-threshold proposal lacking an active financial preparer, including agent preparation. Authorization cannot replace an existing active financial preparer or make that person eligible for self-approval.
- `usage.correction.decide`: `correction`, `decision` (`approved` or `rejected`). Approval revalidates the exact sources, customer, policy, balances, tax and wording. Credits above the threshold require different active owner/finance preparation and approval; agents never approve. Duplicate/stale/foreign decisions are refused.
- `GET /api/nectar/usage/corrections?subscription=ID`: current read authority receives retained source plans, financial effects and honest mail custody. Erased-customer personal receipts are unavailable.
- `invoice.correction.refresh`: `invoice` replaces only an unissued correcting draft after available carried credit or invoice settings change. It preserves approved deltas and wording, discards the old draft, and returns the fresh id for ordinary approval/issue.

All negative differences create numbered credit notes with exact saved tax attribution. Under `next_invoice`, their full amount carries to later invoices; other policies offset the unpaid original and carry the excess. A fully paid customer's credit remains liability. Later recurring, manual and correcting invoices apply available credits once after total, with a source-citing informational line. Totals/tax/revenue are not reduced again, and backdated application before credit issue is refused. Positive differences become next-invoice lines or a normal separately reviewed correcting draft. Original documents never change; unresolved historical additions or pending corrections block ordinary issue.

Subscription commitment burn-down keeps each effective contribution alongside `originalEarnedCents`, `originalTrueUpCents`, signed `replayEarnedCents`/`replayTrueUpCents` and the approving `corrections` ids. Operator drill-through links those receipts and the unchanged original invoice; subscription CSV exports the identical source breakdown. These fields appear when an original period has an approved replay.

Approval atomically records effective replay, credits/queued debits and one frozen customer-message reservation. Native provider acceptance is not delivery; claimed/uncertain sends are not retried. Original-event citations, before/after tax/revenue and the identical explanation appear in the customer's existing scoped `/portal/corrections/ID` projection. Usage CSV retains original status plus effective void/correction custody. `reports/tax` subtracts only exact attributed credit tax; `reports/credit-balances`, its source drill-through/CSV and monthly frozen snapshots show current unspent historical usage credits, excluding general overpayments and cash refunds; prepaid paid/promotional lots are included with typed money/unit quantities.


## PORT-005 customer sessions

An owner calls `portal.configure` with optional merchant `brand_name` (up to 120 characters) and `brand_color` (`#RRGGBB`), plus exact origin arrays `hosts` and `parents` (HTTPS; loopback HTTP only in a local installation). Configuration changes revoke earlier sessions. `portal.session.issue` takes `customer`, `origin`, `audience` (`hosted` or `embedded`) and, for embedded sessions, an approved `parent` origin. It returns `id`, `token`, `url` and `expiresAt`. Issuance, configuration and `portal.session.revoke` (`session`: the id) require owner authority and the configured fresh second factor. Treat the returned URL as a credential; do not log or publish it. Never give the installation's `PORTAL_KEY` to a browser.

`GET /portal?session=TOKEN` opens the customer’s read-only billing overview; its invoice links open customer-scoped issued details. `/portal/data?session=TOKEN` returns the same scoped invoice figures as JSON. These doors accept no operator authentication as a customer capability, and customer tokens grant no operator API authority. They send no-store and no-referrer. Embedded HTML restricts `frame-ancestors` to its signed, owner-approved parent; hosted HTML refuses framing. The runnable sample and branded-host routing instructions are in `examples/portal/README.md`. Customer pages use the merchant name/accent and contain no operator navigation or Nectar mark. `/portal/privacy?session=TOKEN` shows only that customer’s request state. Like the existing erasure confirmation page, the privacy form page uses `strict-origin` referrers (never the session URL), so a native browser form supplies its `Origin`; other portal pages retain `no-referrer`. Its form POST requires the exact session origin and `confirm=yes`; it accepts no customer/recipient selector, records an unverified request, and uses the existing on-file email verification and owner approval. Customer sessions cannot verify alternatively, approve or purge. `GET /portal/answers?session=TOKEN&invoice=ID` opens the customer answer form. `/portal/answer` accepts `invoice`, `question`, optional `topic` and `comparison_invoice` as query parameters; customer identity is fixed by the signed session and other fields are refused. All ten issued-invoice topics reuse the deterministic evaluator, which interprets supported English and Spanish wording (accent-insensitive) or an explicitly selected topic. Unsupported authenticated requests retain the customer language; invalid/expired sessions and cross-origin refusals use English. Every figure points to `/portal/evidence/invoices/ID` or its `/lines/LINE` child and an exact JSON pointer. These source doors expose allowlisted saved financial operands, without operator notes, metadata, payment references/evidence or the original raw calculation document. Questions and sources are write-free, scoped to the customer and revoked with the session. Generated customer labels follow the customer language; human charge descriptions remain as written. `POST /portal/answer-proposal?session=TOKEN` accepts only `invoice`, `question`, optional `topic`, `credit_amount` and `reason`, with exact Origin. It creates an ordinary pending AGENT-002 invoice-credit proposal attributed as a customer; no operator Actor, credit or customer message is created by reading. `/portal/proposals/ID` shows only that customer’s request and its human decision. GOV-002 thresholds, separate approval and stale source/recipient refusal remain unchanged. `/portal/upcoming` and `/portal/subscriptions/ID/upcoming?period=YYYY-MM` use the ordinary engine for own live subscriptions, with exact usage and approved remaining contract credits; `/portal/usage.csv?subscription=ID&period=YYYY-MM` exports those same meter-period quantities. `/portal/adjustments` and `/portal/corrections[/ID]` expose only that customer’s approved frozen explanations and exact effects; unapproved/rejected proposals are unavailable. Current amendment and raw/derived unbilled-usage effects equal the next ordinarily issued invoice; issued credits retain original tax and do not change the upcoming calculation. No future usage or mailbox delivery is claimed. Privacy retention, receipts and archive repetition are now asserted beginning with a populated customer request; receipts remain under existing operator authority after erasure revokes customer sessions.

Setup generates a dedicated `PORTAL_KEY`. Installation archives exclude both that key and runtime customer sessions. After restore, issue fresh sessions even when reusing the old key. Owner-approved allowlists and billing records travel; erased customers cannot receive or use sessions. Existing installations must provision the managed key through setup before using issuance.

### Metered feature policies (ENT-002)

After `feature.grant`, the owner posts `feature.policy` with `product`, `feature`,
`meter` (id or code), exact decimal `quota`, `quota_policy` (`soft`, `hard`,
`overage`) and optional `grace_days`. This prepares a GOV-002 request; it changes
no access until the ordinary `policy.decide` approval. A blank meter removes
the usage limit; blank grace removes the unpaid-invoice restriction.

`GET entitlements/{customer}?feature={code}` evaluates the current business-local
date and returns `allowed` plus each subscription path’s exact `quota`,
`warning`, outstanding `payment` sources and explanation. Multiple product
grants retain their own decisions. Quantities aggregate recorded active events
within the anchored billing period, using the configured metric definition;
the quota never changes the catalog price. Hard limits deny at the limit.
Unpaid restriction starts at due date plus grace calendar days, inclusive, and
settling the invoice restores access subject to the other restrictions.

### Captured invoice series and number register (MOVE-011, partial)

`GET /api/nectar/number-register` returns every retained imported invoice, issued
Nectar invoice and imported/native credit note, exact series, duplicates, unparsed numbers
and compact inclusive internal gap ranges. Series group by document kind, exact
prefix and recorded suffix width. Gaps run only between the smallest and largest
recorded suffix; they do not infer documents before or after the capture.
`GET /app/exports/number-register.csv` exports entry, series and gap rows with
amounts in stored cents. Both require invoice-read authority; CSV also requires
export authority. These reads write nothing.

The owner opens `/app/numbering` or posts `invoice.series` with the current
business `revision`. Optional `kind` is `invoice` (default) or `credit-note`;
invoice and credit sequences are independent at both scopes. `mode: "continue"` selects a retained `source_invoice` id;
its exact terminal numeric suffix sets the minimum width and next number. A
source of the wrong document kind/customer, or older than another recorded number in that prefix is refused.
`mode: "new"` takes an unused `prefix` and `width` (1–12) and starts at 1.
Optional `customer` chooses that customer's independent sequence; otherwise the
business sequence is used. Customer sequences take precedence. This owner
cutover action inherits the existing fresh-factor check, saves the selected
source in audit and invalidates saved invoice approvals. Imported-number
collisions refuse issue without consuming a number. No request claims to read
or verify live processor configuration. Live settings import and multiple entities
remain unimplemented. An optional `credit_notes` capture (Stripe's list response
and manifest count) retains issued/void credit-note numbers, source references
and amounts in the import journal and register; it creates no balance adjustment.
Each credit needs its captured invoice and matching customer. Tax breakdowns are
not retained or reported as zero. Ordinary `credit.issue` / governed
`credit.approve` consumes the configured sequence atomically; rejected approvals
and number collisions consume nothing. A source used for continuation blocks
strict import undo. No capture is presented as live provider verification.

### Retained Stripe financial history (MOVE-007)

The ordinary `import.preview` / reviewed `import.apply` doors also accept optional
`payments` (`/v1/charges`), `refunds` (`/v1/refunds`), `disputes` (`/v1/disputes`)
and `subscription_events` (`/v1/events`, filtered to `customer.subscription.*`)
JSON files. Each uses the same Stripe list envelope, a matching `manifest.files`
entry with `count` and `has_more:false`, and the existing multipart or
`NAME_b64` / `NAME_name` transport. A declared file cannot be omitted. Capture
all pages before importing; incomplete lists and conflicting duplicate source
ids are refused. Identical duplicates retain the import kit's collapse behavior.

Each retained payment/refund/dispute keeps its original object, source id,
customer, source invoice/subscription references, source status, positive integer
cent amount, lowercase currency and business-local occurrence date. A refund or
dispute needs its charge in `payments` or a complete expanded charge. Referenced
invoices must be finalized and belong to that customer; charge, refund and
dispute amounts/currencies and source relationships must agree. Subscription
events retain the entire event and its original subscription snapshot, including
earlier terms; they do not rewrite the currently imported subscription. Preview
reports rejected records explicitly. `create.history` counts new retained rows.
These are read-only imported records: no native payment, refund, dispute action,
customer balance change, mail or processor request is executed by importing them.

Retained invoices and credit notes also keep their original objects and currency.
Invoice `issue_date` comes only from `status_transitions.finalized_at`; a legacy
capture without it retains a null issue date and cannot establish dated financial
contributions. Credit issue dates use the credit's `created` timestamp. Invoice
due dates are captured when present. Normalized invoice lines retain their source
line id, original service dates, price/subscription references, expanded price
evidence, recurring interval/count and explicit tax-exclusive/discount amounts.
The original shadow-comparison line amounts and separate invoice discount line
remain intact. Original tax breakdowns remain in source JSON and their exact
sum is retained when supplied. Missing original tax-exclusive evidence is not
invented. Capture expanded line prices (or their full objects in `prices`) for
historical recurring interpretation, even where current billing cannot install
that price. Annual historical invoices remain available; unsupported annual
prices/subscriptions are explicitly rejected as active billing mappings rather
than converted into monthly billing.

The same reviewed fingerprint, retained original file bytes, journal, repeated
apply and strict untouched-batch undo cover these new source kinds. Altered
history or source evidence blocks strict undo. Existing pre-history imports keep
their legacy journal snapshot shape until a new capture supplies source evidence.


### Monthly revenue journal and period close (REV-002)

`GET /api/nectar/revenue-journal` accepts the revenue report's `period` or
`from`/`to` (up to 120 months), and optional `customer` filter. Report readers
receive exact-cent balanced monthly `entries` (account, debitCents, creditCents,
sourcePath), `periods` with opening/closing accrued assets and deferred
liabilities, and original `sources`.
`GET /app/exports/revenue-journal.csv` requires report-read and export authority;
the Revenue schedules page links to it with the current filters.

These are USD pretax journals: billings clearing, accrued contract assets,
deferred revenue and recognized revenue. They exclude tax, cash, collections and
processor settlement; billings clearing is not gross AR. Each invoice's
asset/liability is classified before aggregation. Signed decreases reverse
debit/credit; zero rows are omitted. CSV source links retain period/customer scope.

`revenue.close` (a person with approval and a fresh factor; `period` `YYYY-MM`)
closes the first past month, then each following month in order. A close saves,
immutably, the month's contribution keys, roll-forward (opening + net billings -
recognized = closing), the journals and the frozen billings and collections
reports (opaque source ids and amounts only). It saves one summarized journal per
ledger company (the installation business with `QUICKBOOKS_COMPANY_ID`, and each
billing entity with its recorded company) and posts it to QuickBooks Online under
the accounts Billings Clearing, Contract Assets, Deferred Revenue and Revenue;
imported-source revenue is closed in the packet but has no issuer to post for. A
failed post waits in the `ledger.post` retry queue. `GET /api/nectar/period-closes`
(and `/period-closes/YYYY-MM`) return closed months, packets and postings.

After a close, a saved contribution that was not in its month (a credit note, an
invoice dated inside it, a late recognition) is reported in the earliest open month
with `adjustedFrom` naming its original month; closed months, their journals and
CSVs never change. AGENT-002 previews of corrections that touch a closed month show
`postsIn`, the open month, and refuse approval if a close changed it.

### Collecting a retained open Stripe invoice

The owner configures the optional installation secret `STRIPE_BILLING_SECRET` through the private setup answers or the declared optional deployment secret. For an existing deployment, use `rer deploy --set-secret STRIPE_BILLING_SECRET --env-file /private/mode-0600.env`; the secret stays out of arguments, archives, audit and responses. This connection does not adopt subscriptions or authorize automatic charges.

A current owner with a fresh required factor calls `imported.collection.prepare` with `invoice` (the retained invoice id). The result freezes the original number, amount, account, source and current provider evidence for review. `imported.collection.execute` takes `request`, `basis_hash`, `confirm: true` and `disable_auto_advance: true`. The supported first slice requires the reviewed customer’s saved default card; unsupported payment-method types refuse before any attempt. It durably claims one attempt, stops the original invoice's automatic advancement, and collects only that reviewed remaining amount. A paid, voided, changed, erased or already-claimed source refuses another attempt. `imported.collection.reconcile` with `request` checks an uncertain result; it does not create another payment. Collection receipts contribute once to collections and reduce aging without rewriting original history. The customer page exposes the same explicit forms. Automatic cutover, dunning, portals and non-Stripe collectors remain MOVE-009 obligations.

Raw provider originals are untrusted custody. `imports` exposes retained-file metadata to the owner; `/app/import/JOB/originals/FILE` downloads the selected bytes as an audited, opaque attachment. Every other role and agent is refused. Customer/report/export views contain allow-listed financial operands and the subscription timeline, without provider prose or metadata. Erasure withdraws original bytes through import custody.

After `imported.collection.execute`, a proven charge remains **mirror pending**. A separate `imported.collection.finalize` request with `request` and `confirm:true` re-reads the source and explicitly marks it paid out of band. Neither execution nor read-only reconciliation mirrors automatically; the paid source's number, amount and reference remain unchanged.


### Prepaid credits and native manual card collection

`GET prepaid/{subscription}` and `prepaid/{subscription}/entries/{entry}` require subscription and invoice reads. They expose typed current money/unit balances and append-only source entries. `/app/prepaid/{subscription}` provides the same ledger and governed forms; `/app/exports/prepaid/{subscription}.csv` also requires export authority. Upcoming subscription/customer projections include current prepaid balances with subscription-read authority, without granting access to the privileged ledger. Credit-balance reports keep unit quantities separate from USD amounts and freeze the actual source ledger in scheduled deliveries.

An owner with a fresh factor prepares `prepaid.prepare` terms (paid or promotional, denomination, effective/expiry dates, global priority and rollover). `prepaid.decide` requires an independent active human approver, or explicit sole-owner confirmation. A paid request prepares a real purchase invoice with `prepaid.purchase.prepare`; `prepaid.funding.confirm` grants credits only against full original, unchanged purchase allocations. Reduced or credited purchases cannot fund grants. Preview reads consume nothing; ordinary invoice issue appends each drawdown once. `prepaid.settle` and the daily job settle approved expiry/rollover; threshold policies alone create uncharged funding requests. Automatic charging additionally requires the exact customer authorization and independent approval described below.

`collection.customer.bind`, `collection.prepare`, `collection.confirm` and `collection.reconcile` are owner-only native issued-invoice operations. Mutations require a fresh required factor. The customer account binding must equal the immutable issued billing-entity processor route. Confirmation binds the exact current owed USD amount, customer and saved default card; a durable invoice claim prevents another PaymentIntent. Read-only reconciliation searches and lists existing provider objects. Definitive declines and authentication requirements remain distinct from unknown outcomes. No receipt email is requested. `GET native-collections` is owner-only; it never requires a fresh factor merely to read the retained outcome. This is PAY-008 manual collection, not PAY-003 automatic card/ACH collection or a QuickBooks posting.


`prepaid.topup.prepare` freezes the approved threshold policy, current card/account, fixed purchase, business-calendar-month cap and start/end dates. The signed customer reviews `/portal/prepaid-topups/ID`, explicitly accepts the exact basis, and can revoke there. A different current human approver confirms `prepaid.topup.decide`; the sole owner must explicitly confirm. Daily evaluation or `prepaid.topup.run` reserves one crossing before one off-session card PaymentIntent. Unknown attempts count against the cap and are reconciled with GET only; card replacement, expiry and revocation end authorization. Original purchase invoices remain immutable; credits become effective on actual capture date. No receipt email, ACH mandate or legal-compliance claim is made.

The signed customer's `/portal/prepaid`, `/portal/prepaid/data`, `/portal/prepaid.csv` and lot source pages expose only their own live subscriptions' typed money/unit balances and ledger. Source requests cannot change customer scope. English and Spanish retain identical numeric values; session revocation/expiry and erasure withdraw access.

`prepaid.refund.prepare` permits the owner to review the complete unused part of a verified original card purchase. Independent fresh-factor `prepaid.refund.decide` approval reserves that lot before one refund request. Pending usage, changed evidence, manual receipts and mismatched account custody refuse. Unknown results retain the reservation; `prepaid.refund.reconcile` checks existing refunds without another POST. A proved refund appends a zero-recognition liability reversal and a numbered credit with no future-invoice balance. `reports/refunds`, source CSV and scheduled snapshots show actual negative cash outflow separately from gross collections and ordinary credit notes. Refunds of taxable service, partial arbitrary amounts and cancellation-policy refunds remain INV-005 obligations.

`GET prepaid/refunds?subscription=...`, `/app/prepaid/refunds` and `/app/prepaid/refunds/ID` expose every typed request lifecycle to current payment-and-invoice readers, including support, collections and accountants. Agents receive typed facts only. Current owner/finance approvers additionally receive the frozen quote and free-text reason. Processor JSON is never inline: `/app/prepaid/refunds/ID/proof` is an audited attachment-only download for those current approvers. `/app/exports/prepaid-refunds.csv` additionally requires export authority and contains typed lifecycle, preparer, approver, approval mode and timestamps only. Erasure withdraws narratives and attachments while retaining the typed financial lifecycle, including the opaque refund identifier. This follows ct batch11 section I; owner-only preparation remains an interim gap. The same narrative custody applies when the refund's numbered credit appears in existing invoice, customer or portal reads and saved report/export copies: shared projections carry only the typed refund category, never a copied request reason. Shared credit reads use the typed refund source link to project `unused_paid_credit`, including legacy reasons in restored archives; saved report/export copies receive the category rather than the private narrative. The gate never matches free text. The numbered credit stores the typed category, and shared invoice/customer JSON and pages and portal invoice JSON/pages expose that category only. The gate applies to existing linked credit rows, including restored archives, without a schema change; the request narrative remains on the private refund request.

## Outbound webhooks (DEV-001, current partial implementation)

Owner/developer `webhook.register` accepts `url` (public HTTPS, default port, no user information or fragment) and `consent: true`; it returns the endpoint id and a signing secret once. More → Outbound webhooks exposes the same form. Registration is audited and does not backfill historical events. The endpoint receives typed identifiers, amounts and **event-time metadata**, no built-in credit/refund reasons, payment evidence or contact fields; owner-authored metadata is copied exactly as explicitly authorized. A customer, subscription, invoice, payment, credit-note and subscribed-price metadata snapshot is captured inside the originating database transaction. Registration, rotation, disabling and replay require the owner/developer’s current credential capability and session and fresh factor where configured. Application credentials cannot manage or read webhooks. The adopted custody default awaits ct approval.

`GET webhooks` returns the owner/developer’s endpoint and delivery log; `GET webhooks/{delivery}` and `/app/webhooks/{delivery}` expose attempts. Current finance members may read only that delivery's event type, opaque event id, attempt numbers, HTTP codes and outcomes; URLs, customer ids, payloads and secrets remain owner/developer-only. INT-003 `webhook_failure` is off by default. Opted-in current owners/developers and finance receive one signed-in exact-delivery link on its first failure; unauthorized/opted-out members receive none. Provider acceptance, refusal, suppression and uncertainty retain the existing mail custody and no uncertain mail retry.

`webhook.dispatch` sends due deliveries; the scheduled handler also does this. An atomic claim fences concurrent dispatchers. Network calls time out after ten seconds, redirects are refused, response bodies are discarded, and only HTTP status/outcome is retained. Retry delays are 1 minute, 5 minutes, 30 minutes, 1 hour, 6 hours, then daily through a final attempt at or beyond 72 hours. A five-minute expired claim is retried after an interruption, because reception may have succeeded. `webhook.replay` takes a delivery id, resets its retry window, keeps its original event id and immutable payload, and signs with the current keys. Disabling an endpoint suppresses outstanding attempts; erased customers' deliveries are suppressed and their metadata payloads are withdrawn. Archives exclude endpoints, signing secrets, events and delivery custody: restoring a business never reactivates an outbound destination.

Requests contain JSON `{id, created_at, type, data, metadata}`. Verify **raw bytes** using `Nectar-Signature: t=<unix seconds>,v1=<hex HMAC>[,v1=<overlap HMAC>]`, with HMAC-SHA256 over `<timestamp>.<raw body>`, a five-minute clock tolerance and constant-time comparison. `Nectar-Event-Id` matches the body id. This is at-least-once transport: commit your application's operation and a unique event-id receipt atomically. See `examples/webhook-receiver/server.mjs` for a runnable local receiver with signature verification and durable reception deduplication. `webhook.rotate` takes endpoint id, revision and `overlap_seconds` (0–86400), returns a new secret once and signs under both secrets until overlap expires. Secrets are AES-GCM sealed under the installation key with endpoint-bound additional data; neither lists nor audit disclose them.

| Stripe event family | Nectar event | Current boundary |
| --- | --- | --- |
| `customer.created` / `customer.updated` | `customer.created` / `customer.updated` | Native customer writes and imported customer row changes |
| `customer.subscription.created` / `customer.subscription.updated` / `customer.subscription.deleted` | `subscription.created` / `subscription.updated` | Complete native post-transaction item snapshots; imported row changes are emitted but complete live shadow parity remains unproved; deletion means recorded end-date change, not row deletion |
| `invoice.created` / `invoice.finalized` | `invoice.created` / `invoice.issued` | Saved drafts and immutable issuance |
| `invoice.paid` | `invoice.paid` | Recorded ledger balance reaches zero through allocations, numbered applied credits, carried credits or goodwill; payload labels recorded-ledger-settlement and cash allocated separately; write-offs are not paid |
| `invoice.payment_succeeded` / `invoice.payment_failed` | `payment.recorded` / `payment.failed` | Captured/recorded payment facts and PAY-008 declined/uncertain outcomes; live automatic PAY-004 failure lifecycle remains unbuilt |
| `payment_method.*` | `payment_method.observed` | Only the reviewed PAY-008 card reference observed during collection, not a claimed provider attach/update/detach; full PAY-002/PAY-005 lifecycle remains unbuilt |
| `entitlements.active_entitlement_summary.updated` | `entitlements.updated` | Current ENT-002 typed access/quota decisions, including dated pause/resume boundaries, observed in bounded scheduled pages; no raw usage or private reasons |
| Existing ENT-002 quota exhaustion | `usage.threshold_crossed` | Once per observed non-exhausted → exhausted quota period; independent usage/spend thresholds and threshold invoices remain USE-005 |
| `credit_note.created` | `credit.created` | Numbered credit created; narrative excluded |

DEV-001 remains PARTIAL: the mapped live Stripe shadow-event journey, provider payment-method lifecycle and complete imported subscription snapshots, policy approval remain unproved. Native subscription audit commits snapshot complete item metadata; native lifecycle events contain dates and typed access facts, never narrative. Entitlement observation scans up to 100 customers per dispatch, continues by cursor and does not promise a one-minute bound at arbitrary scale. This map states the current API; it does not claim a live sync or a completed replacement for unsupported event families.

## Parent payers and division consolidation (CAT-009, partial)

`hierarchy.configure` is an owner-only, fresh-factor action with `customer`, `parent`, `billing_mode` (`consolidated` or `separate`), current relationship `revision` (0 for new) and `consent: true`. Authorization is audited. One level and the same billing entity are required; cycles, reparenting and stale requests are refused. Relationship changes affect new invoice approvals: invoice inputs include the exact parent, mode and revision, so changing them invalidates a pending approval. They never rewrite issued originals.

Prepare ordinary division bill-run drafts, then call owner-only `hierarchy.invoice.prepare` with `parent` and `invoices` (1–20 source draft ids). Their service periods must match. One parent draft contains each division's saved calculation, subtotal, tax and total and uses ordinary `invoice.approve` / `invoice.finalise`. Issue atomically consumes each division service component and usage event once and discards its unissued source draft; competing consolidated drafts and later division re-preparation cannot bill the same service. Revenue usage allocation retains each division's original event/timezone evidence. The invoice screen shows division subtotals. Current consolidation refuses prepaid, individual signed commitments and historical correction/carried-credit sources. This prevents claiming parity those sources have not proved.

In `separate` mode each new division invoice freezes a parent-payer record at issue. PAY-008 `collection.prepare` reads the **parent's** explicit Stripe association and shows the parent payer, exact card/account and division invoice. Only the owner's confirmation charges it, and the payment is recorded and allocated on the division's original invoice; no second parent receivable is created. Changed/erased payer identity or billing entity refuses the prepared source. Existing unlinked collection behavior and pending basis hashes remain compatible. Linking accounts never creates an automatic charge or grants portal access. Consolidated invoices are withheld from the customer portal until its disclosure policy is approved.

Owner-only `GET hierarchies` and `/app/hierarchies` expose relationships, consolidation forms and shared spending commitments. `hierarchy.commitment` records a parent, amount, `from`/exclusive `to` dates and explicit consent. Its report sums immutable issued division/consolidated sources into exact per-division drawdowns, remaining spend and overage. It is tracking only; it neither funds an invoice nor executes a minimum true-up. Full shared commitment execution and all credit sharing remain CAT-009 gaps. The conservative custody/disclosure default awaits ct approval, so CAT-009 remains PARTIAL.


Shared parent credit execution is unavailable. A branch-only experiment was withdrawn because child financial expiry could recreate spent parent goodwill; independent donor-debit and child-receipt retention custody is required before enabling this capability.

## Issued advance-plan changes (SUB-002, partial)

The owner prepares `lifecycle.policy` with `proration_policy: invoice_now | next_invoice | none`, alongside the existing cancellation/reactivation fields. A different current owner/finance approver applies it through `policy.decide` (the existing explicit sole-owner policy confirmation remains available). The pending review and history show the exact proration choice. It is unconfigured until approved; a policy revision invalidates pending change quotes.

`plan.change.prepare` accepts `subscription`, its current `item`, target `price`, seat `quantity` if applicable, and `mode: immediate | period_end`. It requires records/draft and subscription read authority; non-invoice readers receive only their own minimal priced quote. Current issued support is one compatible fixed/seat advance component with matching cadence/taxability and no prepaid, signed commitment, lifecycle or earlier correction on that source period. Unsupported combinations are refused. Immediate means today's business-local date; period end means the paid service window's existing end. Old/new service pieces use the original validated interval expansion and the ordinary rating core, never today's tax rate or a changed invoice.

A different human approver uses `plan.change.decide` with `change` and `decision: approved | rejected`. `invoice_now` issues the exact positive delta as a separately numbered invoice; payment requires the owner's explicit PAY-008 confirmation. If issue is interrupted after approval, the saved invoice link exposes the ordinary finalisation door; approving the plan again cannot create another document. `next_invoice` retains the exact positive delta and historical tax as a once-only adjustment for the next ordinary invoice. A negative advance delta issues a governed numbered credit against the original invoice; any already-paid part remains carried customer credit for a later invoice, never a claimed cash refund. Credit requests are bound to this change and cannot execute through another door. GOV-002 threshold/fresh-factor requirements continue to apply. `none` waives the quoted current-period difference; no invoice or credit is created. All modes retain the new full price for the next period.

A new current-period advance stub is marked covered by the original invoice and its approved delta or waiver, so an ordinary bill run cannot bill the full new stub again. The issued original and its tax/revenue schedule stay immutable; a debit has an exact saved revenue delta and a credit has separate reversal custody. Changed source balance/revision/policy, a later date for an immediate quote, self-approval, concurrent approval, duplicate execution and a second change in the same issued source period are refused. Erasure withdraws quote/source personal data while retaining typed financial facts. `GET subscriptions/{id}` exposes `planChanges` to invoice-authorized subscription readers; lower-authority subscription readers receive no issued-invoice quotes. The ordinary legacy `change.prepare`/`change.decide` path still serves unissued scheduled changes.

Whole-clause SUB-002 remains PARTIAL: automatic PAY-003 collection, mixed/metered/prepaid/signed-term lifecycle cases and repeated issued-period changes are not proved by this implementation.

Sales and custom draft members with subscription read may prepare issued-plan quotes. Their response and own subscription quote history contain only dates, mode/policy and priced before/after/delta figures; invoice ids/balances, source fingerprints, raw tax/certificate, target-price and revenue internals are omitted. They cannot approve or prepare credit requests. A negative sales quote waits for `plan.change.credit.prepare` by current owner/finance; its bound credit request then follows the GOV-002 threshold, so its preparer cannot execute an above-limit credit. Erased customers’ saved quotes cannot be approved or financially prepared.

### Prepaid refund intake and notices (CAT-012)

`prepaid.refund.prepare` requires a current owner/finance member with `approve` and a fresh factor. Supply `grant` for direct financial preparation, or `refund` to prepare the current quote for a pending support/customer intake; `reason` is private to financial members. A different current owner/finance member approves via `prepaid.refund.decide`; self-approval is always refused.

`prepaid.refund.request` is support-only and takes `grant`. The signed own-customer portal posts `grant` to `/portal/prepaid-refund.request` with its current session and same-origin request. Repeated submissions return the existing active lifecycle id. Intake moves no cash, reserves no credit and grants no approval authority. Typed reads and CSV preserve `requestedBy`, `requestedByKind`, `requestedAt` separately from the financial preparer.

`GET prepaid/refund-notices` is owner/finance-only. `prepaid.refund.notice.configure` is owner-only, takes the current `revision`, `language` and each outcome's `_sender`, `_subject`, `_body` (`refunded` and `failed`). Senders are `off`, `nectar`, `processor`; both default off. Templates must retain `{amount}`, `{units}`, `{purchase}`, `{credit}`. Terminal outcomes reserve one notice, and claimed/uncertain/failed sends never retry. Processor-owned outcomes never send Nectar mail. Delivery text and addresses retain financial-member custody and are withdrawn on erasure.

## Currency and composed customer sources

Customers and immutable price versions accept USD (default), CAD, EUR or GBP. The customer currency freezes once billing records exist; item prices, invoices, credits, payments and allocations must match it. Native Stripe collection binds the reviewed lowercase currency and preserves captured transaction currency. `GET /api/nectar/currency/rates` and `GET /api/nectar/reports/currency?from=YYYY-MM-DD&to=YYYY-MM-DD` require report reads. The report converts each invoice on issue date, payment on receipt date, and credit on its business-local issue date using a recorded daily rate; exact integer arithmetic rounds half away from zero once per transaction. Missing rates return `daily_rate_required`, never a substituted quote. Record views keep original money and expose `reporting.status=rate_required` until the dated rate exists. Billings, collections, credits and tax reports and their source/CSV doors convert each transaction once and distribute those exact USD cents across components, retaining original money and the immutable daily source/date/rate. AR, MRR, unbilled, credit-balance, revenue and scheduled bundles containing them, aging, reminders/cadences and USD-only instruments refuse foreign currency until their conversion semantics are implemented; this slice does not complete CAT-008.

`GET /api/nectar/trial-collections?subscription=ID` is a member-approval read. Automatic first-payment authority is separate from ordinary manual collection: one exact USD fixed/seat advance invoice on one date only, approved while its saved terms/card are current. Extensions invalidate it; an explicit new authorization is required. Missed dates expire without catch-up. A durable native claim precedes the sole processor POST; uncertain results use the existing GET-only recovery path. Runtime automatic-debit authority is excluded from archives; native invoice/payment/claim facts remain portable. Arrears, usage and complex financial instruments retain ordinary manual collection.

Customer records compose typed native processor references and verified historical card summaries, prepaid/refund/credit facts, source-scoped audit headers, subscription histories and write-offs/recoveries under each existing family capability. Original refund narratives, processor JSON and audit detail do not enter this projection. `childAccounts` keeps each child's own record and ledger beside its relationship; parent-paid child invoices are never counted as new parent invoices or payments. Moved history remains separate from native totals. Each future payment/refund/dispute or receipt source (PAY-002/PAY-004/PAY-006, INV-005, AR-003) must join the same family-scoped composition with erasure and original-source parity before it ships.

`customer.payment_methods.refresh` is an explicit owner-session action with the configured fresh factor. It reads every card and US-bank-account page from each held Stripe customer binding, checks account/customer/mode identities and atomically replaces only complete typed observations. The customer record exposes `billingRecord.savedPaymentMethods` to payment-and-invoice readers: card brand/last four/expiry or ACH bank name/last four/type, provider account/customer references and verification time. It stores no routing/full account numbers or billing-details JSON. Snapshots, including restored copies, are historical observations and confer no debit authority or mandate. A changed binding or erasure withdraws the projection. Card brand plus last four, or last four alone, resolves through the same scoped customer search.

`payment.ach_evidence.record` explicitly verifies an existing external ACH payment. An owner session with the configured fresh factor supplies `invoice`, `account_ref`, `payment_intent_ref` and `confirm`. GET-only provider reads require the exact invoice metadata, bound customer/account/mode, succeeded captured unrefunded bank payment and available settlement transaction for the exact current invoice balance. The atomic ordinary bank-transfer payment/allocation and immutable typed `billingRecord.achPaymentEvidence` preserve the settlement date, bank name and last four. Duplicate attribution, changed sources and foreign bindings refuse; no mandate, debit initiation, provider write or receipt email is created.

Every native recorded payment receives one immutable sequential receipt number, including a deterministic upgrade backfill. `GET /api/nectar/payments/ID/receipt` and `/app/payments/ID/receipt` require both payment and invoice reads and expose only original cash/currency/date, actual allocations/returns/unallocated cash and typed processor provenance. The customer record's `billingRecord.receipts` uses that same source, and receipt-number search resolves only its customer. Manually recorded cash is not represented as bank settlement. Receipt numbering and cash facts survive archives; erasure removes private identities and processor provenance while preserving permitted financial facts. This internal receipt source sends no email and does not complete INV-005's customer delivery obligations.
