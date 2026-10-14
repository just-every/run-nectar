## Products and prices

Open **More → Catalog**.

- **Meters** name the usage you bill, with a code (the meter name in usage
  files), a name and a unit, for example `events`.
- **Products** have a code and a name, and can grant named features.
- **Prices** belong to a product and are one of three kinds: **Flat monthly**,
  **Per seat monthly** or **Per unit** of a meter. Unit prices are exact
  decimals, such as `499.00` or `0.0004`.

A price never changes once written. A new price is the next version (v2, v3 …),
and subscriptions keep the version they use until a change moves them. Retire a
version to stop new subscriptions using it.

## Customers

Open **Customers** and fill in **Add a customer**:

- **Customer ID:** the id your CRM or previous biller uses. Usage files refer to
  customers by it, and it must be unique.
- **Name**, **Billing email** and **Billing address**.
- **Tax exempt**, with the exemption certificate reference.

A customer's page shows what they owe now, unallocated payments, their
subscriptions, invoices and payments, extra billing contacts, and an
explanation of each feature they hold.

## Subscriptions

On a customer's page, **Start a subscription**:

- **Start date** and **Billing day of the month (1–28)**: each period starts on
  that day.
- **Trial ends** (optional): fixed and seat charges start on this date; usage
  during a trial is recorded and not charged.
- One or more prices, with the number of seats for per-seat prices.

One customer cannot have two live subscriptions rating the same meter.

## Contract exceptions

A subscription can carry a **discount** on fixed and seat charges, a
**one-time credit** or a **contract price** for one plan price, each with dates,
a note and the contract clause quoted. An exception is recorded as proposed and
bills only once a person approves it. An exception that would start inside a
period already invoiced is refused: record a credit note instead.

## Plan and seat changes

On the subscription, **Preview change** shows the affected period as it is and
with the change (prorated by days), and the next full period. **Approve this
preview** commits exactly that; the bill run charges what the preview showed. A
change dated inside a period already invoiced is refused.
