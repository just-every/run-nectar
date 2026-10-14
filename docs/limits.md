Nectar is an invoicing engine. These are outside its first release.

## Money and sending

- It never collects a payment, holds card details or retries a payment. Record
  payments that arrived elsewhere.
- It never sends an invoice or a reminder. Reminders download for you to send
  from your own mail.
- It is not a merchant of record.

## Tax

- You declare one US state's policy: no sales tax, or one flat rate on taxable
  lines. Nectar applies it; it does not determine where you owe tax, and it
  does not file returns.

## Billing shapes

- US dollars only, one business.
- Monthly periods only, billed after each period ends; billing days 1–28.
- No graduated or volume tiers, minimum commitments or prepaid wallets.
- No revenue recognition.

## Moving in

- Stripe Billing only. Chargebee, Recurly and Maxio records cannot be moved in
  yet.
- Stripe subscription schedules are recorded, not carried out.
