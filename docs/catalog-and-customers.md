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

## Coupons, promotion codes and trials

Under **Catalog → Coupons and promotion codes**, a person with approval creates
reusable **coupons**: a percentage or an amount, once, for a number of months or
forever, optionally restricted to products (percentage coupons only; an amount
coupon is a run of one-time credits). A **promotion code** redeems a coupon with
an optional redemption limit, an expiry date and a first-time-customer rule (a
customer with a paid invoice is refused). Type the code in **Promotion code**
when starting a subscription: Nectar checks it and records the redemption in the
same transaction, then bills the discount on the covered fixed and seat lines for
the coupon's duration, counted from the first billed day (the trial end date when
there is a trial). A coupon restricted to a product discounts only that product's
lines on a mixed invoice.

A trial records whether a payment method is on file. An operator can **Extend
trial**, which moves the first charge to the new end date. At the end date a
trial with a payment method converts to paid, and one without ends unpaid with no
charge; a trial with no recorded payment method is never resolved automatically.
Nectar does not charge the card by itself: collect the first invoice through the
owner-confirmed card collection.

## Customer payment methods

From a customer's saved payment methods, an owner with a fresh authenticator or passkey verification prepares a card or ACH setup. The customer opens the hosted portal, explicitly accepts saving the method, and separately chooses whether it becomes the default. Stripe owns the financial fields and ACH verification. Setup grants no debit authority.

To change an existing default or remove a completed hosted method, open “Manage a saved method,” prepare the exact choice, and have the customer confirm it in the portal. Choose a replacement before removing the current default. Pending collection authority prevents removal. An uncertain result offers reconciliation of the original request; it never repeats the processor write. Existing financial approvals keep their original method.

The same section shows verified card updater observations and methods prohibited after a hard decline. An owner can reconcile an actual processor updater event by reference. A hard decline stays prohibited even when another updater event arrives; a replacement needs its own collection approval.

Card expiry notices currently require owner review and a separate send confirmation exactly fourteen local calendar days before renewal. The prepared warning freezes its recipient and localized wording. The private setup link expires at the displayed time, within fifteen minutes. Acceptance by the mail provider is recorded separately from mailbox delivery. Unattended notices, long-lived update access and the complete renewal journey remain unproved under PAY-005.

For verified card updater intake, configure the optional Stripe card event signing secret and point the matching Stripe endpoint at `./api/nectar/stripe/card-events`. Intake denies requests until configured. It observes current card facts only; it does not send mail or authorize payment. The owner can also reconcile a genuine event reference from the customer record.
