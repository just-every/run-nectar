## Roles

| Role | Can |
| --- | --- |
| Owner | Everything, and the only one who changes the business, the tax policy, access, credentials and a move-in cutover |
| Finance operator | Keep records, import usage, prepare and approve bill runs, record payments and work receivables |
| Accountant | Read and export |

Every page, form, API call and download checks the role itself.

## Give someone access

Open **More → Access → Give someone access** with their name, email and role,
and press **Invite**. They sign in with their email. **End access** ends their
access and every session they hold.

## Multi-factor sign-in

Under **More → Access → Multi-factor sign-in**, the owner requires a second
factor for chosen roles (by default Owner and Finance) or for everyone. A
required member opens **More → Sign-in security**, adds an authenticator app or
a passkey, and keeps the ten one-time recovery codes shown once. Until they
have a factor and have confirmed it in their current session, every page,
form, API call and download sends them back there.

Credits, access and credential changes, changing the requirement and adopting
a moved-in subscription ask for a fresh code once the last check is more than
15 minutes old. **Reset factor** on Access removes a member's factors and
signs them out everywhere. Agent credentials can never do any of these.

Authenticator-app secrets are sealed with the installation's `MFA_KEY`, which
setup generates. Keep a copy with your archives: a restore without it puts
members back at enrollment, with the reason shown on Sign-in security.

## Agent credentials

Under **Agent credentials**, the owner issues a credential with a name and
scopes:

- **prepare**: read records and propose work for approval.
- **usage**: submit usage events.

The key is shown once; Nectar keeps only its fingerprint. Send it as
`Authorization: Bearer …` to `/api/nectar/`. **Revoke** ends it immediately.

A credential never approves, finalizes, issues a credit, changes a record
directly or manages access.

## Proposals

With `prepare`, an agent proposes:

- **Contract terms** from a signed agreement, quoting each clause and flagging
  anything ambiguous.
- **A price change** for selected subscriptions from an exact date.
- **A usage correction** to a draft bill run, with its sources.
- **A collections reminder.**

Nectar computes each proposal's effect on invoices itself. Open **More →
Proposals** to read it, then **Approve** or **Reject**. A proposal whose
records changed after it was prepared cannot be approved; ask for a new one.
Approving a usage correction prepares the draft run again; its invoices still
need their own approval.

Company agents use the [shared door](agent-door.md), with their current native sponsor and the company's signed policy. Native person-only decisions and fresh-factor requirements still apply.
