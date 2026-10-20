# Embedded customer billing

The sample is a runnable merchant app, using Nectar's real customer portal.
It does not create billing records or substitute operator pages for a portal.

1. Start Nectar with `rer dev` and configure the owner-approved portal host and
   parent `http://127.0.0.1:3000` through `portal.configure`. Optional
   `brand_name` and `brand_color` (a six-digit hex color) set the merchant name
   and accent. Without a name, the business legal name is used.
2. As the owner, call `portal.session.issue` for the intended customer with
   `audience: "embedded"`, the Nectar origin and that exact parent origin.
   Save the JSON response to a mode-0600 file outside the checkout.
3. Run `PORTAL_SESSION_FILE=/private/path/session.json node examples/portal/server.mjs`
   and open `http://127.0.0.1:3000/billing`. This single-customer local sample
   treats possession of the local file as its operator's explicit choice of
   customer. Never expose this sample server publicly.

For an authenticated merchant app, import `portalApp` from `app.mjs` and supply
`sessionForRequest`. That backend must authenticate its own visitor and obtain
the session for that visitor's customer, rather than accept a customer ID or
portal URL from the browser. The callback can return null to refuse a visitor.
The sample never receives Nectar's signing key or an operator credential.
Sessions expire after 15 minutes; replace the private file with a newly issued
session for a later local visit. Do not log session URLs or commit that file.

For a branded subdomain, route the merchant's HTTPS hostname to the same Nectar
Worker (including `/portal/*`), approve its exact HTTPS origin and issue a
`hosted` session for it. The request URL must retain that hostname; forwarding
headers cannot substitute for it. Open the returned URL directly. Hosted
sessions refuse framing, embedded sessions permit only the approved parent,
and neither works on a different portal origin. Domain/DNS provisioning belongs
to the installation owner; the local browser journey uses a real HTTPS listener
and the same Worker to exercise these routes without claiming a live DNS setup.

The portal currently provides issued billing records and privacy requests.
Payments, plan changes, the full cited-answer journey and other PORT-001..004
capabilities remain open in CONTRACT.md.
