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
| `invoices.json` (optional, needed for shadow comparison) | `GET /v1/invoices` |
| `meters.json` (needed for metered prices) | `GET /v1/billing/meters` |
| `manifest.json` | written by you: `{"source": "stripe", "captured_at": "…", "files": {"customers": {"count": N, "has_more": false}, …}}` |

Every file in the manifest must contain exactly the declared number of
records and `has_more: false`; otherwise Nectar refuses the capture as
incomplete. `tests/fixtures/stripe/` holds an invented example in this shape.

## How records map

- **Customers** keep the Stripe id as their customer id, so usage files can name them. `tax_exempt` `exempt` or `reverse` becomes an exemption referencing it. A customer already in Nectar under that id is kept, and its history attaches to it.
- **Products** keep the Stripe id as their code. **Billing meters** become meters named by their `event_name`.
- **Prices** become price versions in creation order. Monthly USD per-unit prices only: licensed prices become flat (seat when any subscription uses a quantity other than one, or when `metadata.nectar_kind` says so), metered prices become per-unit prices on their meter. `unit_amount_decimal` cents keep up to four decimal places of a cent. Tiered, non-monthly, one-time and non-USD prices are refused with a reason.
- **Subscriptions** keep their start date, billing day (from `billing_cycle_anchor`, in the business's timezone; days 29–31 are refused), trial end, end date, collection method and up to six items with quantities. A percent-off coupon becomes an approved contract discount over its dates; other coupons, Stripe tax rates and subscription schedules are listed to recreate in Nectar. `incomplete`, `incomplete_expired` and `paused` subscriptions are refused.
- **Invoices** (except drafts) are kept read-only as the previous biller's history, line by line with each line's price and period, and discounts as one line.

## Preview, apply, undo

1. **Preview** (More → Move in) shows what would be created, what is refused and why, what to check afterwards, and the capture's coverage. Nothing is written.
2. **Apply** re-reads the same files and applies only if the result still matches the reviewed preview's fingerprint. Applying the same preview again adds nothing. Each batch is checked against the current session's role in the same database transaction that writes it.
3. **Undo** removes a batch whose records nobody has edited or built on. Once a moved-in record is part of a bill run, has usage, payments or edits, undo lists the blockers and refuses.

## Shadow, then cutover

Prepare a bill run for a month Stripe already billed. Moved-in subscriptions
appear as shadow drafts with a price-by-price comparison against Stripe's
invoice lines for the same period; they cannot be approved. When a period
agrees, the owner adopts the subscription under Move in, choosing a cutover
that starts a period after the last one Stripe billed; Nectar refuses any
earlier cutover and never drafts a period before it. Then turn off the
subscription's schedule in Stripe yourself. Card details stay with Stripe;
Nectar collects nothing.
