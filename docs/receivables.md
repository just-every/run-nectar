Nectar records payments received outside the installation and shows who owes what.
Approved reminders and historical correction explanations use the configured
mail provider; provider acceptance does not confirm mailbox delivery.

## Credit notes

On an issued invoice, **Issue credit note** with an amount and a reason. A
credit note is numbered and can never exceed what the invoice still owes.

Historical usage corrections have a separate governed path from the issued
invoice's **Historical usage replay** link. Their numbered credit notes retain
full original-tax attribution even when the original invoice is paid. Under
**Next invoice**, the full credit carries forward; other policies offset the
unpaid original and carry the excess. The invoice shows **Face amount** and
**Applied here** separately. Customer records and **Credit balances** report
show the remaining historical correction liability, with source, CSV and frozen
monthly-report parity. Later recurring, manual and correcting invoices apply
that liability once after their total, with the credit number on an informational
line. This records no cash refund and no negative invoice. General overpayment,
goodwill, prepaid and refundable balances remain separate unfinished capabilities.

## Write-offs and bad debt

On an issued invoice, **Bad debt write-offs** lets a person with approval write
off an uncollectable balance with a reason. The saved request names the exact
balance, amount, reason and accounting effect (debit **Bad Debts**, credit
**Accounts Receivable (A/R)** for the customer). Execution removes the amount
from ageing, the AR report and collection, and leaves the issued invoice
unchanged: invoiced = credited + paid + written off + owed. The owner's
second-person threshold (set with the credit threshold) applies: above it,
**Write off now** is refused and a different authorized person must approve the
saved request; at or below it one person executes. A changed balance, policy or
already-executed request is refused and changes nothing. Agents cannot write
off, prepare or approve.

A later recovery is recorded with **Record recovery**: pick the recorded payment
and the amount (never more than the payment's unallocated amount or the
write-off still outstanding). The payment is allocated to the invoice, the
write-off's net amount falls, and the ledger receives the reversing entry.

Each write-off and recovery saves its balanced journal entry in the same
transaction and posts it to QuickBooks Online with the installation's
`QUICKBOOKS_ACCESS_TOKEN`, `QUICKBOOKS_ENVIRONMENT` (`sandbox` or `production`)
and the entity's recorded company (or `QUICKBOOKS_COMPANY_ID` when the customer
has no billing entity). A failed or unconfigured post never undoes the
write-off: it waits as a pending posting with an error code, and **Retry
pending ledger postings** (`ledger.post`) posts it once, adopting an entry the
ledger already recorded. Granting and refreshing the connection is part of the
full books sync (`BOOK-001`).

## Customer credit balance

A customer's **Credit balance** (customer record) is their unallocated cash
(overpayments), goodwill credit and carried correction credit, with its own
ledger. **Grant goodwill credit** adds goodwill; **Record return of balance**
returns the unallocated cash of a payment and records the wire or check
reference of the money the business sent back (Nectar sends none). The owner's
second-person threshold applies: above it, **Prepare for a second approver** and
a different approver executes the saved request. The balance applies to an
invoice when an approver runs `balance.apply`, or automatically when it issues
if the owner sets `balance_application` to `automatic` through `credit.policy`;
goodwill applies first, then the oldest cash. The credit balances report, its
source pages, CSV and scheduled snapshots equal this ledger.

## Payments

Open **Receivables → Payments received** and **Record payment**: the customer,
the amount, the date it was received, the method (**Bank transfer**, **Check**
or **Card (taken outside Nectar)**) and its reference, which must be unique.
Then allocate it on the invoice with **Allocate payment**. An allocation never
exceeds the payment's unallocated amount or the invoice's balance.

Every invoice shows the sum: invoiced = credited + paid + written off + owed.

## Ageing

**Ageing** lists each customer's balance as **Not yet due**, **1–30 days**,
**31–60 days**, **61–90 days** and **Over 90**, with what is past due in total.

## Reminders

**Draft reminder** prepares a message stating the overdue invoices, balances
and recent payments. A person checks the recipient and wording and presses
**Approve recipient and wording**; if the balances change first, the draft must
be prepared again. **Download message** saves it to send from your own mail.

Approving a reminder opens a dated follow-up task. Close it with what happened
(for example, "Ada confirmed payment run").
