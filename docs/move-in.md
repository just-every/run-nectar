Nectar moves your records in from Stripe Billing and compares its own invoices
with Stripe's before you switch. It moves records, not billing: nothing is
billed twice, and card details stay with Stripe.

## Capture your Stripe records

With a restricted, read-only Stripe key, save each list response as JSON. Follow
`has_more` and `starting_after` until each list is complete, and merge the
pages into one `data` array:

| File | Request |
| --- | --- |
| `customers.json` | `GET /v1/customers` |
| `products.json` | `GET /v1/products` |
| `prices.json` | `GET /v1/prices` |
| `subscriptions.json` | `GET /v1/subscriptions?status=all&expand[]=data.discounts` |
| `invoices.json` | `GET /v1/invoices` (needed for the shadow comparison) |
| `meters.json` | `GET /v1/billing/meters` (needed for metered prices) |
| `manifest.json` | written by you, with each file's record count |

```json
{
  "source": "stripe",
  "captured_at": "2026-10-01T09:00:00Z",
  "files": {
    "customers": { "count": 2, "has_more": false },
    "products": { "count": 3, "has_more": false }
  }
}
```

Each file must hold exactly the count the manifest declares, with `has_more`
false; otherwise Nectar refuses the capture as incomplete.

## 1. Preview

Open **More → Move in**, choose the files and press **Preview the move**. The
preview lists the new customers, products, prices, meters and subscriptions,
everything refused and why, what to check afterwards, and the capture's
coverage. It writes nothing.

What moves:

- **Customers** keep the Stripe id as their Customer ID.
- **Prices** become price versions: monthly USD prices only. Tiered, yearly,
  one-time and non-USD prices are refused with a reason.
- **Subscriptions** keep their start date, billing day, trial end, end date and
  items. A percent-off coupon becomes an approved discount; other coupons,
  Stripe tax rates and subscription schedules are listed for you to recreate.
- **Invoices** are kept read-only as the previous biller's history.

## 2. Apply

**Apply this exact move** applies only if the files still match the preview you
reviewed. Applying the same move again adds nothing. **Undo this move** removes
a batch nobody has edited or billed on; once its records are used, undo lists
what blocks it.

## 3. Shadow and cutover

Moved-in subscriptions bill nothing. Prepare a bill run for a month Stripe
already billed: the moved-in subscriptions appear as shadow drafts with a
price-by-price comparison against Stripe's invoice. When a period shows
**Reconciled**, the owner presses **Adopt** with a cutover that starts after the
last period Stripe billed; Nectar refuses an earlier one. Then turn off the
subscription's schedule in Stripe yourself.
