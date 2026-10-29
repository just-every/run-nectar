# Moving in from Stripe Billing

Nectar's first move-in kit reads Stripe Billing records the owner captures
from the Stripe API and brings them in through Base's import kit: a preview
that writes nothing, an apply bound to the exact preview, a journal with the
original files retained, and undo. It moves records, not billing: moved-in
subscriptions are compared with Stripe in shadow and bill nothing until the
owner adopts each one.

## What to capture

With a restricted, read-only Stripe key, save each list response as JSON
(follow `has_more`/`starting_after` until the list is complete, and merge the
pages into one `data` array):

| File | Request |
| --- | --- |
| `customers.json` | `GET /v1/customers` |
| `products.json` | `GET /v1/products` |
| `prices.json` | `GET /v1/prices` |
| `subscriptions.json` | `GET /v1/subscriptions?status=all&expand[]=data.discounts` (items are included) |
| `invoice_items.json` (optional, complete pending items) | `GET /v1/invoiceitems?pending=true` |
| `invoices.json` (optional, needed for shadow comparison) | `GET /v1/invoices` |
| `credit_notes.json` (optional, needed for captured credit-note continuation) | `GET /v1/credit_notes` |
| `meters.json` (needed for metered prices) | `GET /v1/billing/meters` |
| `manifest.json` | written by you: `{"source": "stripe", "captured_at": "…", "files": {"customers": {"count": N, "has_more": false}, …}}` |

Every file in the manifest must contain exactly the declared number of
records and `has_more: false`; otherwise Nectar refuses the capture as
incomplete. `tests/fixtures/stripe/` holds an invented example in this shape.

## How records map

- **Customers** keep the Stripe id as their customer id, so usage files can name them. `tax_exempt` `exempt` or `reverse` becomes an exemption referencing it. A customer already in Nectar under that id is kept, and its history attaches to it.
- **Products** keep the Stripe id as their code. **Billing meters** become meters named by their `event_name`.
- **Prices** become price versions in creation order. Monthly USD per-unit prices only: licensed prices become flat (seat when any subscription uses a quantity other than one, or when `metadata.nectar_kind` says so), metered prices become per-unit prices on their meter. `unit_amount_decimal` cents keep up to four decimal places of a cent. Tiered, non-monthly, one-time and non-USD prices are refused with a reason.
- **Subscriptions** keep their start date, billing day (from `billing_cycle_anchor`, in the business's timezone; days 29–31 are refused), trial end, end date, collection method and up to six items with quantities. A percent-off coupon becomes an approved contract discount over its dates. Supported fixed-amount USD coupons retain their original start, exclusive expiry, consumed months and product restrictions as native amount terms; once, repeating and forever terms do not restart at adoption. Unsupported or ambiguous fixed discounts are refused. A true `cancel_at_period_end` retains `current_period_end` as the cancellation boundary even if `cancel_at` is absent; conflicting or non-midnight boundaries are refused. Fully expanded active `schedule` objects carry contiguous monthly fixed or seat phases as dated native items. The current phase must agree with the captured subscription. Supported `release` keeps the final price; `cancel` stops at the final boundary. Other phase effects, such as discounts, trials, one-time additions, automatic tax and anchor changes, are refused. A bare schedule id retains the existing attention warning because no phases were captured. Stripe tax rates remain unqualified. `incomplete`, `incomplete_expired` and `paused` subscriptions are refused.
- **Pending invoice items** require `invoice_items.json` and its exact manifest count. Each item must have `invoice: null`, an explicit captured subscription and matching customer, positive whole USD cents, a reconciled integer quantity, `discountable: false`, and an explicitly empty `tax_rates` array. Proration, discounts, tax rates and ambiguous customer-wide items are refused before any import writes. Each item becomes an immutable native charge dated at the captured current period start and is consumed once by the adopted subscription invoice. A pending item cannot be manually billed, and adoption must use that captured period start; a different date requires a fresh source capture. This upload establishes no live source synchronization.
- **Invoices** (except drafts) are kept read-only as the previous biller's history, line by line with each line's price and period, and discounts as one line.
- **Credit notes** retain issued/void USD source numbers, references and amounts as read-only history. Include the credit note's invoice and matching customer in the capture. They appear in the number register, without changing invoice balances or shadow comparisons. Credit tax breakdowns are not retained; the register leaves those fields empty.

## Preview, apply, undo

1. **Preview** (More → Move in) shows what would be created, what is refused and why, what to check afterwards, and the capture's coverage. Nothing is written.
2. **Apply** re-reads the same files and applies only if the result still matches the reviewed preview's fingerprint. Applying the same preview again adds nothing. Each batch is checked against the current session's role in the same database transaction that writes it.
3. **Undo** removes a batch whose records nobody has edited or built on. Once a moved-in record is part of a bill run, has usage, payments or edits, undo lists the blockers and refuses. A document selected for numbering continuation also blocks undo, including when only its credit-note series has been selected.

## Shadow, then cutover

Prepare a bill run for a month Stripe already billed. Moved-in subscriptions
appear as shadow drafts with a price-by-price comparison against Stripe's
invoice lines for the same period; they cannot be approved. When a period
agrees, the owner adopts the subscription under Move in, choosing a cutover
that starts a period after the last one Stripe billed; Nectar refuses any
earlier cutover and never drafts a period before it. Then turn off the
subscription's schedule in Stripe yourself. Card details stay with Stripe;
Nectar collects nothing.

## Captured numbering (MOVE-011, partial)

The owner opens **Number register** at `/app/numbering` and chooses the
document kind (invoice or credit note) and scope (business or customer).
Continuing a retained source preserves its exact prefix and minimum suffix
width, including multipart credit numbers such as `C9E0C52C-0036-CN-01`.
The ordinary governed credit door then uses the next number. An unused new
series starts at 1. Customer sequences take precedence for that customer;
invoice and credit-note sequences remain independent. A collision or refused
approval consumes no number.

The accountant can export the combined imported/native register and internal
gap ranges as CSV. A capture is not live verification of Stripe's numbering
settings. Live configuration, multiple-entity routing and the complete real
Stripe sandbox acceptance remain open under MOVE-011.
