# Meter usage, then gate a feature

This Node 22 sample submits one real observed usage event and then asks Nectar
for one explained entitlement decision. Both the exported function and CLI
branch on the returned `allowed` value. An allowed result permits the caller
to proceed; a denied result leaves access denied. Recording the observation
does not imply access, and the example does not perform a protected product
operation or create any new consent.

Compile from the checkout root using its existing compiler:

```sh
./node_modules/.bin/tsc -p examples/typescript-sdk/tsconfig.json
node examples/typescript-sdk/dist/examples/typescript-sdk/src/cli.js
```

The sample has independent `build`, `check` and `start` scripts. Its compiler
includes the actual SDK source, so the SDK does not need a preceding build.
There are no runtime dependencies, fixtures or simulated transport responses.

Configure these named environment variables before invoking the CLI. Provide
secrets through your normal private environment mechanism; do not put them
in shell history or logs.

| Variable | Meaning |
| --- | --- |
| `NECTAR_BASE_URL` | Installation origin, or complete native API root. |
| `NECTAR_SESSION_COOKIE` | Existing member Cookie header value; choose this or the bearer token. |
| `NECTAR_ORIGIN` | Exact installation origin, required with a member cookie. |
| `NECTAR_BEARER_TOKEN` | Existing native credential used to record usage. |
| `NECTAR_READ_BEARER_TOKEN` | Optional separate native credential authorized to read customer entitlements and metadata. |
| `NECTAR_VERSION` | Optional `2026-10-01` or `2026-10-20`; omission preserves native version selection. |
| `NECTAR_EVENT_ID` | Stable identifier from the caller's durable observed operation. |
| `NECTAR_IDEMPOTENCY_KEY` | Caller-owned key for this exact ingestion request. |
| `NECTAR_CUSTOMER` | Existing customer external ID. |
| `NECTAR_METER` | Existing source-stream meter code. |
| `NECTAR_QUANTITY` | Exact decimal string, such as `0.000001`. |
| `NECTAR_OCCURRED_AT` | Recorded ISO 8601 instant with an explicit offset. |
| `NECTAR_FEATURE` | Feature code whose decision controls access. |
| `NECTAR_DATE` | Optional valid `YYYY-MM-DD` decision date; omission uses the current business-local day. |

A native usage credential cannot read entitlements. Pair it with an existing
prepare credential through `NECTAR_READ_BEARER_TOKEN`, or use an existing member
whose authority covers both operations. The sample never obtains credentials
or grants new authority.

The CLI prints JSON with `outcome: 'allowed'` or `outcome: 'denied'`, usage
counts and the server's actual decision. Both are successful evaluations and
exit zero. A rejected ingestion, authentication error or transport failure
exits nonzero. Repeating the same unchanged event and HTTP request uses the
caller-owned identifiers; the sample never manufactures another ID or retries.
To observe both paths, evaluate already configured features or customers with
different current grants or quota states. The sample does not change policies
or invent a decision.

## Exported function

After compilation, import the side-effect-free entry point. `readClient`
defaults to `client` when one member has the needed authority.

```ts
import { meterThenGate } from './examples/typescript-sdk/dist/examples/typescript-sdk/src/index.js'

const result = await meterThenGate(client, {
  event: recordedEvent,
  feature: 'api-access',
  date: '2026-10-29',
  idempotencyKey: recordedRequestKey,
}, readClient)

if (result.allowed) {
  console.log('Access allowed', result.decision.feature)
} else {
  console.log('Access denied', result.decision.paths)
}
```

`recordedEvent` has `event_id`, customer external ID, source meter code, string
`quantity`, `occurred_at` and optional native scalar `properties`. Metering
happens before the entitlement request. A 200 response with a rejected event
throws before gating, while an accepted or unchanged duplicate proceeds.

## Metadata example

To read metadata and list exact matches after the decision, set all of:

| Variable | Meaning |
| --- | --- |
| `NECTAR_METADATA_KIND` | `customer`, `subscription`, `price`, `invoice`, `payment` or `credit-note`. |
| `NECTAR_METADATA_RECORD` | Original record's internal ID. |
| `NECTAR_METADATA_KEY` | Exact key; the empty string is valid. |
| `NECTAR_METADATA_VALUE` | Exact string value; the empty string is valid. |

The CLI performs only metadata reads. Programmatic callers can explicitly
replace a reviewed complete map through the exported example:

```ts
import { readMetadataExample, replaceMetadataExample } from './examples/typescript-sdk/dist/examples/typescript-sdk/src/index.js'

const target = { kind: 'customer' as const, record: internalCustomerId }
const view = await readClient.metadata.get(target)
// Review the complete replacement map before calling the write example.
const metadata = Object.fromEntries([['', ''], ['__proto__', 'exact value']])
await replaceMetadataExample(memberClient, {
  ...target, revision: view.revision, metadata,
}, 'reviewed-metadata-replacement-42')
const found = await readMetadataExample(readClient, target, { key: '__proto__', value: 'exact value' })
```

The write requires an existing authorized member, an explicitly supplied
reviewed revision and a caller-owned idempotency key. It replaces the complete
map; it does not silently merge or retry a stale revision. Empty keys, Unicode,
whitespace and own `__proto__` entries retain their exact values.

## Existing checkout and customer portal

The compiled sample also exports server-only `openExistingCheckout` and
`issueHostedPortal`. Call them explicitly from a trusted owner action using an
existing native owner member client. Never place the owner cookie, factor,
credential headers or this owner client in customer browser code. The
`ownerInvoked: true` argument records explicit invocation intent; native server
authorization remains the security boundary.

```ts
import { openExistingCheckout, issueHostedPortal } from './examples/typescript-sdk/dist/examples/typescript-sdk/src/index.js'

const checkout = await openExistingCheckout(ownerClient, {
  baseUrl: installationOrigin,
  link: existingApprovedPaymentLinkId,
  ownerInvoked: true,
})
// Return checkout.url to the intended customer, who reviews native checkout terms.

const portal = await issueHostedPortal(ownerClient, {
  customer: internalCustomerId,
  origin: alreadyApprovedPortalOrigin,
  ownerInvoked: true,
  idempotencyKey: ownerPortalInvocationKey,
})
// Return portal.url only through the intended customer's private response.
// Never log portal, portal.url, portal.token or a successful response body.
```

The checkout helper reads the existing native management list, requires the
selected link to be active, approved and activated, verifies that its returned
path matches the link identity, and resolves that relative path against the
supplied installation origin. It rejects external destinations, traversal,
encoded path separators, fragments, query strings and credential-bearing base
URLs. It returns `{ link, url }`; it performs no customer checkout POST or
provider request. The public customer door separately rechecks current terms,
owner availability, remaining capacity and processor evidence.

The checkout helper is a read and needs no idempotency key. Existing native
`ownerClient.paymentLinks.create(input, { idempotencyKey })` explicitly creates
a reviewed link policy if the application needs one. Creation can leave a
subscription policy pending approval and inactive; the sample does not approve
or activate it. Subscription checkout captures a card through the provider's
setup flow and creates the native subscription after verified completion.
One-time checkout uses the provider's payment flow for the exact invoice.
Returning a checkout URL proves neither completed setup nor completed purchase.
The current native processor support is test mode; no unsupported production
checkout is claimed.

The portal helper explicitly issues one existing customer-scoped hosted session
using the caller's idempotency key. It never configures hosts, grants consent or
logs its capability URL. Already approved origins, internal customer identity,
owner authority and any configured fresh factor are still required. Use
`ownerClient.portal.sessions.revoke({ session: portal.id }, { idempotencyKey })`
only after a separate explicit owner decision to revoke that session. Embedded
sessions use the SDK's typed `portal.sessions.issue` directly and require the
existing approved parent origin.

These helpers are exported functions, never an automatic step of the metering
CLI. Deliver the returned URL through an authenticated private response and
keep customer redirects separate from the owner-authenticated HTTP transport.
