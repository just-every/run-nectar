Nectar runs on your own computer with two commands. Your data stays in your
installation.

## Run it

You need Node 22 or later and pnpm 10.12.4, on macOS, Linux or Windows with
WSL2.

1. Install `rer`, the Run Edit Run command, once per computer:

   ```sh
   curl -fsSL https://runeditrun.com/install.sh | sh
   export PATH="$HOME/.local/bin:$PATH"
   ```

2. Get Nectar and start it:

   ```sh
   git clone https://github.com/just-every/run-nectar.git nectar
   cd nectar && rer dev
   ```

`rer dev` installs everything, sets up a local owner on a free port, starts the
app and prints a link that opens Nectar signed in. Open that link on the same
computer and treat it like a password: it signs the browser in as the owner.

To install for a real owner mailbox, run the steps yourself:

```sh
rer install
rer setup
rer dev
```

`rer setup` asks for the owner's email. Stop the app with `rer dev --stop`.

## Finish setup

The first page asks you to confirm the owner of this installation. Tick
**I confirm this owner account is ready to use.** and press **Finish setup**.

## Enter the business

Before anything else, Nectar opens **Business and tax**:

- **Billing identity:** the legal name, billing address, the billing email
  shown on invoices, the billing timezone, the invoice number prefix and the
  payment terms in days. Press **Save and continue**.
- **Billing timezone:** billing periods start and end at midnight in this
  timezone. It cannot change once an invoice is issued.
- **Tax policy:** choose your state and either **No sales tax applies to what
  we sell** or **Charge one flat rate on taxable lines**, with the rate and the
  basis for the declaration (for example, who advised it and when). Press
  **Declare tax policy**, then **I have reviewed this tax policy**.

Nectar applies the policy you declare; it does not work out where you owe tax
or file returns. Invoices cannot be finalised until the owner has reviewed the
declaration, and any change needs a new review.

## The first billing cycle

Home lists the steps that remain:

1. Enter the business billing details.
2. Declare the tax policy and have the owner review it.
3. Add a product and its price ([Prices, customers and subscriptions](/docs/catalog-and-customers)).
4. Add a customer, or move in from Stripe ([Moving in](/docs/move-in)).
5. Start a subscription.
6. Prepare, approve and finalise a bill run ([Bill runs and invoices](/docs/bill-runs)).

Once they are done, Home shows **Your work**: draft bill runs to review,
proposals waiting for a decision and overdue invoices.
