Nectar is free, open source subscription billing for a B2B software or service
business. It turns monthly plans, seats and metered usage into invoices where
every line shows how it was calculated, then tracks credits, payments and
overdue follow-up. It is MIT licensed, and it runs on your own computer or your
own Cloudflare account.

## Who it is for

One US business that bills its customers monthly in US dollars: a flat plan,
seats, usage of a meter, or a mix of the three. Usually an owner and a finance
operator run it, with an outside accountant who reads and exports.

## How a month works

1. **Prices and customers.** You keep a catalog of products and prices, and
   your customers under the ids your CRM or previous biller already uses.
2. **Subscriptions.** Each customer's subscription names its prices, seats,
   billing day and any contract exception (a discount, a one-time credit or a
   contract price), which bills only after a person approves it.
3. **Usage.** Usage arrives as a CSV file or from your metering pipeline. Before
   anything is rated you can see each period's exact totals, the days without
   usage and anything that arrived late.
4. **The bill run.** For a month, Nectar drafts one invoice per ended period,
   compares each with the customer's previous invoice and the run with last
   month's, and lists anything unusual.
5. **Approval.** A person approves the drafts. Approval names the exact inputs:
   if usage, a price, a contract term or the tax policy changes before
   finalizing, the approval no longer holds.
6. **Finalizing.** Approved invoices are numbered in order (`INV-000001`
   upward) and never change. Corrections are credit notes.
7. **After the invoice.** Payments you received are recorded with their
   reference and allocated, ageing shows who owes what, and reminders are
   drafted for you to send from your own mail.

## Every line explained

Each invoice line keeps its rule, quantity and unit price. A usage line reads
like this:

| Charge | Quantity | Unit | Amount |
| --- | --- | --- | --- |
| Event processing (v1) | 3,346,778.5 | $0.0004 | $1,338.71 |

Rule: sum of event quantities × unit, rounded half away from zero once.

Money is exact: prices and quantities are exact decimals, and each line is
rounded once to whole cents. The same inputs always give the same bill, and
every invoice records the rule version (`nectar-rating-1`) and a fingerprint of
its inputs.

## Where to go next

- [Getting started](/docs/getting-started): run it and enter your business.
- [Bill runs and invoices](/docs/bill-runs): the month-end routine.
- [Moving in from Stripe Billing](/docs/move-in): try it beside your current biller.
