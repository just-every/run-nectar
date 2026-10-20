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
| `subscription.create` | owner, finance | `customer`, `start_date`, `anchor_day`, `trial_end`, `price[]`, `quantity[]`, optional `exception_*` |
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
| `credit.policy` | owner | `two_person_above` (decimal dollars; empty disables the threshold); prepares a policy request |
| `credit.prepare` | a person with approval | `invoice`, `amount`, `reason`; returns `request` against the current balance and policy |
| `credit.approve` | a person with approval | `request`; above the threshold, the approver must differ from its preparer |
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
- **List cursors.** Every list door (`customers`, `payments`, `runs`, `proposals`, `audit`, `members`, `credentials`, `usage/batches`, `notices`, `tasks`, `policies`, `imports`, `shadow`, `erasures`, `note-members`, `notes/KIND/ID`, `objects/KIND`) accepts `limit` (1–100, default 100) and `cursor`, returning `{data, next_cursor}`; without either it returns the whole list. The cursor continues after the last returned row in the list's current order and binds the path and page size; rows placed before it appear only in a fresh listing, and a cursor whose row has left the list answers `409 cursor_stale`. Other doors refuse paging with `400 not_a_list`.

## Customer notes (`CUS-002`)

`POST /api/nectar/note.add` accepts `kind` (`customer`, `invoice`, `payment`), `record` (the internal record id), `body` (1–4,000 trimmed characters) and optional `mention` (an array of up to 20 distinct active member ids). A signed-in owner or finance member records the note; customer ownership is resolved from the target record, never a caller-supplied customer. The result is `{id: customerId, note: noteId}`. Notes have no update/delete door: add a follow-up. Supplying an id or customer override is refused.

`GET /api/nectar/notes/{kind}/{record}` reads the record's notes. `GET /api/nectar/customers/{id}` includes every note on that customer, its invoices and payments. Both use the existing read capability. `GET /api/nectar/note-members` lets a member with the records capability select active mention recipients. Each note records the server timestamp and author; mention outcomes distinguish provider acceptance, local suppression, failed delivery and uncertain delivery. An uncertain attempt is not automatically retried. Notification links open the signed-in customer or invoice page; payment notifications name the payment reference and link to the customer's notes.

`GET /app/exports/customers.csv` requires export capability and contains customer billing details plus `notes_json`, including note contents, author/date, record identity and mention outcomes. Existing installation archives retain both new domain tables through the ordinary export/import path. Operator customer/invoice pages provide the same append-only forms, and customer pages include a payment-note form for each listed payment.

## Live usage and upcoming invoices (`USE-006`)

`GET /api/nectar/subscriptions/ID/upcoming` requires the existing read capability and defaults to the anchor period containing today in the business timezone. Optional `period=YYYY-MM` chooses the period starting in that month. Invalid months are refused; periods outside the subscription's service dates or owned by the previous biller are refused. Reads write nothing and are never cached.

The response contains exact current-period meter quantities/event ids, earlier unbilled quantities/event ids separately, unused approved one-time contract credits and their applicability dates, and `calculation` with the bill-run engine's exact inputs, lines, tax, exceptions, rating version and fingerprint. Fixed charges cover the full service period while usage includes recorded inputs only, with no forecast of future ingestion. Draft source reconciliation is included. Later input changes produce a new fingerprint and invalidate any older approved bill draft as before. `remainingContractCreditCents` names one-time contract credits, not prepaid credit balances.

An already issued selected period returns `state:"issued"`, its invoice id and immutable saved calculation rather than re-rating unbilled events as a second invoice. Shadow subscriptions return `state:"shadow"`, never an issuable preview. The subscription screen has the same current calculation, a month selector, live usage and approved credits; the Usage screen links each subscription-period to it. Portal parity belongs to PORT-002 and prepaid balance parity to CAT-004 before either ships.

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

### Historical usage correction preview (USE-004, partial)

`POST /api/nectar/usage.correction.preview` requires billing read authority. Send `subscription`, `from_period`, `through_period` (inclusive YYYY-MM), `void_event_ids` and `add_event_ids` (distinct string arrays, at most 10,000 each). The range must contain every issued recurring invoice for at most 36 monthly periods. Additions must already exist as unbilled usage for that customer and an original source meter. The response reproduces saved originals, replays the selected events with the original rating versions, prices, tax and predecessor context, and returns per-invoice before/after lines, exact signed deltas, fingerprints and citations. It is always unresolved and covers only the chosen range; downstream periods may need another replay. This action changes no billing records and cannot clear an issue block or authorize a financial disposition. The issued invoice links to the same preview at `/app/usage/replay`.

## PORT-005 customer sessions (partial)

An owner calls `portal.configure` with optional merchant `brand_name` (up to 120 characters) and `brand_color` (`#RRGGBB`), plus exact origin arrays `hosts` and `parents` (HTTPS; loopback HTTP only in a local installation). Configuration changes revoke earlier sessions. `portal.session.issue` takes `customer`, `origin`, `audience` (`hosted` or `embedded`) and, for embedded sessions, an approved `parent` origin. It returns `id`, `token`, `url` and `expiresAt`. Issuance, configuration and `portal.session.revoke` (`session`: the id) require owner authority and the configured fresh second factor. Treat the returned URL as a credential; do not log or publish it. Never give the installation's `PORTAL_KEY` to a browser.

`GET /portal?session=TOKEN` opens the customer’s read-only billing overview; its invoice links open customer-scoped issued details. `/portal/data?session=TOKEN` returns the same scoped invoice figures as JSON. These doors accept no operator authentication as a customer capability, and customer tokens grant no operator API authority. They send no-store and no-referrer. Embedded HTML restricts `frame-ancestors` to its signed, owner-approved parent; hosted HTML refuses framing. The runnable sample and branded-host routing instructions are in `examples/portal/README.md`. Customer pages use the merchant name/accent and contain no operator navigation or Nectar mark. `/portal/privacy?session=TOKEN` shows only that customer’s request state. Its form POST requires the exact session origin and `confirm=yes`; it accepts no customer/recipient selector, records an unverified request, and uses the existing on-file email verification and owner approval. Customer sessions cannot verify alternatively, approve or purge. Full cited customer answers, correction-kind/next-invoice parity and complete privacy retention/archive repetition remain PORT-005 gaps.

Setup generates a dedicated `PORTAL_KEY`. Installation archives exclude both that key and runtime customer sessions. After restore, issue fresh sessions even when reusing the old key. Owner-approved allowlists and billing records travel; erased customers cannot receive or use sessions. Existing installations must provision the managed key through setup before using issuance.
