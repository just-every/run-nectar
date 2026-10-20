## Downloads

**More → Exports** downloads, for your records or your accountant:

- issued invoices, usage events and subscriptions as CSV,
- any bill run as one JSON document with every invoice's lines, calculation
  inputs, fingerprint, approval and issue events.

## Save the whole installation

From the folder Nectar runs in, stop the app and export everything:

```sh
rer dev --stop
rer export --output exports/nectar.rer
```

The archive holds every Nectar record, approval, calculation and the audit
trail. It leaves out sign-in sessions, the local outbox and private settings.
Keep it somewhere safe; it contains your customers and their invoices.

## Restore

Restore into an empty installation, then set the owner up again:

```sh
rer reset --yes
rer import --input exports/nectar.rer --yes
rer setup
rer dev
```

`rer reset` removes this checkout's local data, so export first. Import refuses
a damaged archive and refuses to restore over existing data. Every portable row,
including each invoice's calculation evidence, comes back unchanged.

Authenticator-app secrets travel only sealed under `MFA_KEY` (in `.dev.vars`
locally, a Worker secret when deployed). Keep that key with the archive; a
restore under another key or none puts members back at enrollment with the
reason shown; passkeys keep working.

To move to another computer, clone Nectar there, copy the archive into its
`exports/` folder and run the import and setup steps.
