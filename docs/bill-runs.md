## Prepare a bill run

Open **Billing**, choose the **Month** and press **Prepare draft**. Nectar
drafts one invoice for every subscription period that started in that month and
has ended. Periods not yet ended and periods already invoiced are listed, not
drafted. Preparing again replaces the draft.

## Review it

The bill run shows the month on one page:

- **Invoices**, **Subtotal**, **Tax**, **Total**, and the change against the
  previous month's run.
- **Exceptions**: missing usage, a large change against the customer's previous
  invoice, unrated usage, no billing email, tax not declared, credits that
  exceed charges, and a mismatch with the previous biller. Tax not declared and
  credits exceeding charges block approval until they are fixed.
- **Draft invoices**, each with its change against the last invoice. **Review →**
  opens one.

## Read an invoice

Each line shows its charge, quantity, unit price and amount, with its rule
underneath (for example `unit × quantity`, or `sum of event quantities × unit,
rounded half away from zero once`). **Details** on a line holds the full
evidence: the days, the events, the price version. Under the lines are the
subtotal, the tax at the declared rate and the total.

**Comparison** shows the customer's previous invoice and, for a subscription
moved in from Stripe, whether Stripe's invoice agrees on every price.

## Approve

**Approve clean drafts** approves every draft with no exceptions. When
exceptions are listed, tick **I reviewed the exceptions** and press **Approve
reviewed drafts**, or approve one invoice from its page.

Approval names the exact inputs. If usage, a price, a contract exception or the
tax policy changes before finalizing, the approval no longer holds: prepare the
bill run again and review it.

## Finalize

**Finalize approved** numbers and issues every approved invoice whose inputs are
unchanged. The invoice date can be any day from the end of the billed period up
to today (it defaults to today); the due date follows your payment terms. Each
period is billed once, and each usage event is billed on one invoice only.

Issued invoices never change. To reduce one, issue a credit note
([Credits, payments and reminders](/docs/receivables)).

## Keep the evidence

**Download bill run (JSON)** saves every invoice in the run with its lines,
calculation inputs, fingerprint, approval and issue events.
