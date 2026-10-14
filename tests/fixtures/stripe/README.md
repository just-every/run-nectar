# Stripe Billing move-in fixtures

Invented businesses in the documented shape of Stripe API list responses
(`{"object": "list", "data": [...], "has_more": false}`) for customers, products,
prices, subscriptions (expanded `data.items` and `data.discounts`), invoices and
billing meters, plus the owner's capture manifest. Amounts follow Stripe's
convention (integer cents in `unit_amount`, decimal cents in `unit_amount_decimal`);
times are Unix seconds. Shapes follow https://docs.stripe.com/api; no data came
from a Stripe account. The set deliberately includes records the first release
refuses: a tiered price, a yearly price, an incomplete subscription and a draft invoice.
