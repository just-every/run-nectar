# Normalized subscription analytics

Open **Billing → Normalized MRR** or **Normalized ARR**. Billed recurring remains a separate report based on issued consideration. The normalized reports instead evaluate retained subscription terms at the end of each calendar month in the business billing timezone. Their source links open the exact subscription snapshot, contract operands and source reference used for that month. Trials, pauses and cancellations remain drillable even when their contribution is zero.

USD simple fixed and seat prices are supported. Monthly prices divide by the number of months; annual prices divide by twelve. Weekly prices multiply by 52 and divide by twelve and the interval count; daily prices use 365 instead of 52. Dated price overrides and renewal uplifts apply before active percentage discounts. Percentage discounts add within their applicable subscription, product or item scope and cannot reduce a fee below zero. Each item's rational MRR rounds once, half away from zero; ARR multiplies the exact rational amount by twelve before rounding independently. The report sums those displayed item cents.

Trials contribute zero until their end. Effective native pauses and cancellations contribute zero, while a future period-end cancellation contributes until its effective date. Captured active and past-due source subscriptions contribute; other captured source statuses contribute zero. A source collection pause leaves the contract rate active. Metered usage, one-time fixed credits, amount coupons, minimum commitments, prepaid balances, tax, proration, credit notes and refunds do not change this run rate. Other currencies and nonsimple fixed or seat prices are refused rather than silently omitted.

The uploaded subscription creation and update snapshots establish pre-adoption terms. Invoices never substitute for missing contract snapshots. Adoption continues the same subscription history using native terms from the cutover date, without resetting customers or cohorts. Corrections preserve the retained source months; governed proposals freeze their exact before and after MRR and ARR using the same definition as the report.

## Customer movements and retention

All analytics amounts use MRR, including on the ARR page. A paying customer has positive MRR summed over its selected subscriptions. Multiple subscriptions belonging to the same customer count once. Each month's opening amount is the preceding month's closing amount.

- **New:** the customer's first positive month-end MRR.
- **Expansion or contraction:** an increase or decrease between two positive customer balances.
- **Churn:** a positive customer balance becomes zero.
- **Reactivation:** a zero balance becomes positive after an earlier positive month.

Opening MRR plus new, expansion and reactivation, less contraction and churn, equals closing MRR. These are net month-end customer movements; changes entirely between snapshots are not separately counted. Movement evidence includes both months' exact subscription contributions.

Logo churn is lost paying customers divided by opening paying customers. Revenue churn is contraction plus churn MRR divided by opening MRR. Net revenue retention includes expansion of opening customers; gross revenue retention excludes expansion. Neither includes new or reactivated customers outside the opening population. Average revenue per account divides closing MRR by paying customers and rounds once to cents. A missing denominator displays no basis, never a zero rate.

Customer cohorts begin in the first positive selected month. Each monthly cell retains the original customer count and starting MRR, the current paying count and MRR, customer retention, net revenue retention and gross revenue retention. Reactivation can restore cohort retention; net retention can exceed 100 percent, while gross retention caps each member at their starting MRR. Starting and current subscription evidence remains available.

Trial cohorts begin in the first observed trial month per subscription. Conversion is the first positive month-end MRR, and the cumulative rate is evaluated only through the selected report month. Each member links to its observed trial and, when converted, its first positive contribution. An unpaid trial that ends without positive MRR never converts. A capture that omits a trial entirely between its snapshots cannot establish that trial.

## Filters and access

The report's month, plan-price, customer-segment and billing-entity controls apply together. A plan price selects the whole subscription containing that exact native price or its original source reference at that month's end. Changing out of a filtered plan can therefore appear as churn within that selected population. Current customer segment metadata and current billing-entity assignment apply across the history; they are not claims about historical assignments. A segment matches exactly, including its case. Empty selections include all values.

Reports retain their existing read authority. Segment filtering additionally requires customer read authority, and changing or revoking a role applies on its next request. Filter choices reveal catalog labels only to catalog readers and customer segment or entity choices only to customer readers. Reading a metric changes no billing record. Erased customers and their retained contract operands are excluded; anonymous normalized-history retention and normalized scheduled snapshots are not implemented.

## Source comparison boundary

These definitions deliberately differ from billed recurring revenue and can differ from a Stripe account's analytics settings: calendar month-end, fixed 52-week and 365-day conventions, additive percentage discounts, per-item rounding and excluded instruments are explicit. The original source's analytics report and settings are not imported or represented as verified. A live source import and cutover and an actual comparison with that account's analytics report remain unqualified. The uploaded capture journey is synthetic public-door proof, not a live-provider receipt.
