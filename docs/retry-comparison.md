Nectar's decline-table v1 recovered five of eight failed payments on this
published deterministic test set: 62.5%, with $1,900 recovered from $3,600.
The fixed three-attempt schedule recovered three: 37.5%, with $1,200 recovered.
This is a measured comparison on a reproducible test-edge set with declared
outcomes. It is not a comparison with any provider's retry product, and it
does not predict production recovery performance.

## Published schedules

Both schedules count the original failed payment as attempt 1, at elapsed
hour zero. All dates use UTC, starting on 1 October 2026 at midnight.

Decline-table v1 allows at most eight total attempts through elapsed hour 336
(14 days). A processing error waits four hours between attempts, do not honor
waits 24 hours, and insufficient funds waits 72 hours. Attempts stop on success
or when the next attempt would exceed either limit. This comparison covers
these three soft card declines only. It does not exercise hard declines, bank
returns, card replacement, disputes or customer authentication.

The fixed comparison makes three total attempts: the first failure, then at
elapsed hours 72 and 168 (day 3 and day 7), stopping on success.

## Known outcomes

The complete machine-readable source is
[`retry-comparison.json`](https://github.com/just-every/run-nectar/blob/main/src/nectar/retry-comparison.json).
Each record names an amount, a first-decline reason and zero or more intervals
of elapsed hours in which a subsequent payment would succeed. An interval
includes its start and excludes its end. Outside those intervals every
attempt fails; the first attempt always fails. The test edge uses those exact
outcomes for both schedules, with no random values or provider requests.

| Payment | First decline | Amount | Success interval, hours | Decline-table recovery hour | Fixed recovery hour |
| --- | --- | ---: | --- | ---: | ---: |
| synthetic-nectar-1 | processing_error | $100 | 4 to before 8 | 4 | None |
| synthetic-nectar-2 | processing_error | $200 | 72 to before 96 | None | 72 |
| synthetic-nectar-3 | do_not_honor | $300 | 24 to before 48 | 24 | None |
| synthetic-nectar-4 | do_not_honor | $400 | 168 to before 192 | 168 | 168 |
| synthetic-nectar-5 | insufficient_funds | $500 | 144 to before 160 | 144 | None |
| synthetic-nectar-6 | insufficient_funds | $600 | 72 to before 90 | 72 | 72 |
| synthetic-nectar-7 | insufficient_funds | $700 | 240 to before 264 | None | None |
| synthetic-nectar-8 | do_not_honor | $800 | Never | None | None |

The set includes a payment that only the fixed schedule recovers, and two
that neither recovers. It makes no claim to represent a merchant population.

## Recorded result

| Schedule | Failed payments | Failed amount | Recovered payments | Payment recovery rate | Recovered amount | Amount recovery rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Decline-table v1 | 8 | $3,600 | 5 | 62.5% | $1,900 | 52.78% |
| Fixed three attempts | 8 | $3,600 | 3 | 37.5% | $1,200 | 33.33% |

Decline-table v1 recovers two additional payments and $700 more on this set.
The payment recovery rate is 25 percentage points higher; the amount recovery
rate is 19.44 percentage points higher. These differences describe this test
set alone. Changing a retry count, window or timing table requires a new
comparison record before making a corresponding recovery claim.

To reproduce, read the fixture, generate each schedule from elapsed hour zero,
and evaluate each later attempt against its payment's success intervals.
Record every attempted offset, stop at the first success, and sum each
successful payment's amount once. Compare the computed offsets, recovered
payment counts, rates and cents to the fixture's `record` entries. The
decline-table replay uses the shipped scheduler, rather than a second copy
of its timing logic.

## Live recovery report

The payment recovery report reads actual failed attempts and payment
allocations. It counts each invoice once, for the amount of its first failed
attempt. A successful first payment never enters that cohort. Every actual
allocation after the failure contributes at most once, up to that invoice's
failed amount; credits and pending or uncertain charges contribute no cash.
Recovered revenue is gross allocated cash before later refunds.

An invoice counts as recovered when allocated cash covers its entire initial
failed amount. Partial recovery contributes its actual amount and appears
separately in the counts. Count recovery rate divides fully recovered
invoices by failed invoices. Amount recovery rate divides allocated recovery
cents by failed cents. A cohort with no failed invoices has no recovery rate.
Currencies remain separate; the report does not sum unlike currencies.

The decline breakdown uses the first failure's reason. Attempt and dunning
step breakdowns count each invoice once in every group it reached. Their
failed exposure amounts therefore need not sum to the overall failed amount.
Recovered cash is assigned by the collected attempt's recorded payment ID,
never by guessing from a payment's time. An allocation with no matching
retry is labelled **No recorded retry attempt**; an absent dunning step is
labelled **No recorded dunning step**. A group's count recovery rate counts
invoices whose entire failed amount was recovered in that group.

Involuntary churn counts only an owner-confirmed attribution of an actually ended subscription to its unpaid failed invoice. The owner confirms the current subscription revision and exact end date with a fresh factor. Neither an exhausted retry series, an unpaid invoice nor a free-text cancellation reason creates that attribution. Recording it changes no debt, payment or subscription state. Each ended subscription counts once.
