<img src="public/brand/mark.svg" width="72" height="72" alt="Nectar">

# Nectar

Nectar is free, open source subscription billing for a B2B software or service
business: monthly plans, seats and metered usage turned into invoices you can
explain line by line, with credits, payment evidence and overdue follow-up.
It runs on your own Cloudflare account; it never collects payments or sends
anything for you.

- Guides for the owner and the finance team: [docs/](docs/overview.md), published on the run site at `/docs`
- What it does and what it will not do: [CONTRACT.md](CONTRACT.md)
- What is proven and how: [ACCEPTANCE.md](ACCEPTANCE.md)
- The JSON API and agent credentials: [API.md](API.md)
- Moving in from Stripe Billing: [IMPORTING.md](IMPORTING.md)
- The project site: [run-nectar.com](https://run-nectar.com)
- Source code: [just-every/run-nectar](https://github.com/just-every/run-nectar)

## Run it locally

Install `rer`, the Run Edit Run command, then start Nectar (the same two lines
as [run-nectar.com/run](https://run-nectar.com/run)):

```sh
curl -fsSL https://runeditrun.com/install.sh | sh
rer dev just-every/run-nectar
```

The first line installs `rer` for you alone, with its own Node if you have no
Node 22 or later. The second clones Nectar, installs it, sets up a local owner
and starts it. Already have Node 22 or later? `npx -y @runeditrun/rer dev just-every/run-nectar`
does both in one line. To start it again later, run `cd run-nectar && rer dev`.

From a checkout, `rer dev` alone launches it for review: it installs pinned
dependencies, sets up a local owner on a free port, starts the real app and
prints `RER_READY` and a sign-in link. To install for a real owner, run `npx -y @runeditrun/rer install just-every/run-nectar`, then from the checkout:

```sh
rer setup --owner-email you@example.com
rer dev
```

Commands that run project work select the exact Node version declared by the
project. They use an exact matching installed runtime or a checksum-verified
copy cached at `~/.rer/node/node-vVERSION-PLATFORM-ARCH/`; when needed on
supported platforms, the runner retrieves the official Node release and checks
its SHA-256 against `SHASUMS256.txt`. It does not change global Node installations.
Set `RER_NODE_AUTO=0` to disable automatic selection. If selection is disabled
or acquisition fails, the command reports a repair invocation in this form:
`npm exec --yes --package=node@VERSION -- node SCRIPT VERB --cwd PROJECT`.
Help, check, describe, doctor and stop do not select or acquire Node.

After `RER_READY`, `dev` prints `RER_SIGNED_IN EMAIL` and `RER_OPEN URL`.
Open that URL on this computer: the app opens signed in as the owner and
finishes first-run setup at `/setup`. Treat the line as a credential.
`dev --as PERSONA` starts as a persona or signed out. Until first-run
completion is stored durably, app routes send the signed-in owner to `/setup`;
signed-out visitors sign in and return there. Once complete, `/setup` opens the
app or settings. Local mail is suppressed; no external email is sent.

The saved local port is used; a first setup saves the first free port from 8787. Explicit ports are decimal
integers from 1 through 65535 and must be free; a busy requested port fails
instead of silently moving. Only `127.0.0.1`, `localhost` and `::1` are allowed.
Dev applies the selected host and port to both the listener and runtime bindings;
readiness is bounded and failure stops the owned processes.

Missing non-interactive setup answers exit 3 and name the manifest fields.
Read `rer-setup.json` and pass a private, mode-0600 JSON object keyed by those
names using `rer setup --answers PATH --non-interactive`,
for example `{"OWNER_EMAIL":"owner@example.com"}`. Secret values stay in
private inputs and never go in command arguments. A setup rerun with the saved
owner and origin preserves existing owner/data and exact private settings.
Conflicting saved identity or origin reports an actionable recovery path.
Review reset's exact removal inventory before confirmation; export domain data
first if it should be restored, and import only into an empty destination.

Queue waits report immediately with a reason and numeric one-based position,
then refresh about every 15 seconds while waiting. Package mode has no queue status command; a waiting command reports its live position.

Use the setup prompt instead of `--owner-email` when entering the real owner
mailbox. Open the `RER_OPEN` URL printed by `dev` on this computer; the app opens
signed in as the owner. No external email is sent. `dev` serves
live editing with HMR and stays in the foreground on its first invocation; a
compatible repeated invocation reuses the server and exits. Stop `dev` with
`rer dev --stop` or Ctrl-C, and stop `preview` with
`rer preview --stop` before build or verification.

```sh
rer verify
rer reset --yes
rer export --output exports/installation.rer
rer import --input exports/installation.rer --yes
rer deploy
rer describe
```

`verify` ends by loading each public page of the production build in Chromium to
prove its sections hydrate as separate units (`src/base/hydration/README.md`); run
`pnpm exec playwright install chromium` once on a new machine.

Reset is destructive local cleanup. Import requires an empty destination and
explicit confirmation. Use `rer describe` to inspect the
checkout's actual commands and flags. The maintained pins are Node 22.20.0 and
pnpm 10.12.4. Read `RUN-LOCALLY.md` for data custody, deploy requirements and
remote-transfer support.

## How it is built

One Cloudflare Worker with D1, Base's owner sign-in and local development
outbox (`src/base`, `src/modules/operator-auth`), and Base's import kit for
move-in (`src/modules/import-kit`). Nectar's own code is in `src/nectar`:
domain modules (rating, bill runs, receivables, collections, proposals,
move-in), the doors (`http.ts`, `actions.ts`, `views.ts`, `doors.ts`) and
script-free server-rendered screens (`ui/`, styled by `public/nectar.css` on
the tokens in `public/fonts/fonts.css`). The schema is `migrations/core/0014_nectar.sql`.

`rer verify` builds, typechecks and runs the Worker checks and every
acceptance flow (`tests/nectar/flows.mjs`). The browser journey and restore
round trip (`tests/nectar/journey.mjs`) run from a disposable fresh clone:
`NECTAR_TEST_CHECKOUT=1 pnpm run test:journey`.

Local durable data lives in `.wrangler/state`; private settings default to
`.dev.vars` with mode 0600. `rer export` writes the complete installation
(every Nectar record, approval, calculation and the audit trail) and excludes
sign-in sessions, the outbox and private settings. `deploy --dry-run` builds
and validates without provider requests; real deployment needs the owner's
Cloudflare account and a real mail provider, and local checks do not establish
hosted acceptance. See `OPERATIONS.md`, `SEED-COMMAND-CONTRACT.md` and
`RUN-LOCALLY.md`.

MIT licensed.
