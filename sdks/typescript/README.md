# Nectar TypeScript SDK

This dependency-free ESM client uses Node 22's real `fetch`. It exposes native
usage ingestion, explained entitlement decisions, all six metadata kinds,
payment-link management and customer portal session issuance.
Other native JSON operations use the same typed request transport. It makes one
HTTP request per call, with no retries or generated event identifiers.

From the checkout root, compile with the existing TypeScript compiler:

```sh
./node_modules/.bin/tsc -p sdks/typescript/tsconfig.json
```

The package also has independent `build` and `check` scripts and declares its
own development compiler. Its runtime has no dependencies. Import its compiled
entry point from `./sdks/typescript/dist/index.js` when working in this checkout.

```ts
import { NectarClient, NectarApiError } from './sdks/typescript/dist/index.js'

const client = new NectarClient({
  baseUrl: process.env.NECTAR_BASE_URL!,
  // Use an existing native member session and the installation's exact origin.
  headers: {
    Cookie: process.env.NECTAR_SESSION_COOKIE!,
    Origin: process.env.NECTAR_ORIGIN!,
  },
  version: '2026-10-20',
})

const usage = await client.usage.submit({
  events: [{
    event_id: 'observed-operation-42',
    customer: 'customer-external-id',
    meter: 'requests',
    quantity: '0.000001',
    occurred_at: '2026-10-29T12:00:00+10:00',
  }],
}, { idempotencyKey: recordedIngestionRequestKey })

if (usage.rejected) throw new Error('Inspect usage.report before proceeding')
const decision = await client.entitlements.check({
  customer: 'customer-external-id', feature: 'api-access', date: '2026-10-29',
})
console.log(decision.allowed)
```

The event identifier must come from the caller's durable operation record.
Keep its customer, meter, exact quantity, timestamp and properties unchanged
when submitting that event again. Usage accepts customer external IDs and
source-stream meter codes. Quantities remain strings throughout; the client
rejects numeric quantities and never rounds or normalizes text. The server
validates decimal precision and event properties. A successful HTTP response
can contain rejected events; inspect `accepted`, `duplicates`, `rejected` and
`report` before treating an event as recorded.

Entitlement checks accept either an internal customer ID or an external ID.
They request one feature and expose the server's `allowed`, evaluated `date`
and explained subscription paths. Omitting `date` uses the business-local
current day. An explicit invalid date is rejected locally, preventing an
accidental current-day decision. Numeric limits and quotas remain exact text.

## Authentication and versions

Supply existing authority through `headers`. A bearer client uses
`{ Authorization: 'Bearer ' + token }`. A member client sends its existing
cookie and the exact installation `Origin` for writes. The client never issues
credentials, signs in, creates consent or upgrades authority. A usage-only
credential cannot read entitlement decisions. Use a separate authorized read
client when needed, as shown in the [sample](../../examples/typescript-sdk/README.md).

Omitting `version` omits the version header and preserves the credential's
pinned version or the member default. Set `version: '2026-10-01'` or
`version: '2026-10-20'` to explicitly send `Nectar-Version`. A per-call version
overrides the client's option. Supplied headers are preserved except the JSON
transport's `Accept`, `Content-Type`, explicit version and idempotency headers.

Every POST requires an explicit `idempotencyKey` option. Nectar binds the key
to the caller, action, version, content type and exact serialized request.
Resubmit an unchanged request under the same key within its native retention
window to obtain the stored successful result. A changed request or a request
still in progress can return 409. The SDK does not retry either case. Keep
original request values and property order when replaying an HTTP write.

## Metadata

Kinds are `customer`, `subscription`, `price`, `invoice`, `payment` and
`credit-note`. Reads retain the current map, revision, history and original
record link. Writes replace the complete map and require the reviewed current
revision; a stale revision produces 409. Metadata write authority belongs to
authorized native members.

```ts
const target = { kind: 'customer' as const, record: 'internal-customer-id' }
const current = await client.metadata.get(target)
// Object.fromEntries creates special keys as own data properties.
const metadata = Object.fromEntries([
  ['', ''],
  ['__proto__', 'exact value'],
  [' Unicode key ', '  value unchanged  '],
])
const saved = await client.metadata.write({
  ...target, revision: current.revision, metadata,
}, { idempotencyKey: reviewedMetadataRequestKey })
const matches = await client.metadata.list({
  kind: 'customer', filter: { key: '', value: '' }, limit: 25,
})
```

The SDK passes maps directly through JSON and filters through `URLSearchParams`.
Empty keys, empty values, whitespace, Unicode and own `__proto__` properties
are preserved. Ordinary JavaScript object literal syntax for `__proto__` sets
a prototype instead of creating that own property; use `Object.fromEntries`,
`JSON.parse` or a null-prototype object for such keys. The native limit is 50
string pairs. A filter always supplies both `key` and `value` and matches the
latest map exactly. Continue with `next_cursor` for the latest dated version
or `nextCursor` for the original version, retaining the filter and page size.

## Generic requests and errors

```ts
interface CustomerPage { data: { id: string; name: string }[]; next_cursor: string | null }
const page = await client.requestResult<CustomerPage>({
  method: 'GET', path: 'customers', query: { limit: 20, search: 'Acme' },
})
console.log(page.data.data, page.version, page.idempotentReplayed)

try {
  await client.request({
    method: 'POST', path: 'customer.create',
    body: { external_id: 'acme', name: 'Acme', billing_email: process.env.NECTAR_BILLING_EMAIL! },
    idempotencyKey: reviewedCustomerRequestKey,
  })
} catch (error) {
  if (error instanceof NectarApiError) {
    // Inspect locally; avoid logging potentially private bodies or headers.
    console.error(error.status, error.code, error.version)
  } else throw error
}
```

`request<T>` returns the JSON result as `T`. `requestResult<T>` returns `data`,
`status`, response `version`, `headers` and `idempotentReplayed`. A generic type
describes the expected response; it does not perform runtime schema validation.
Paths stay within this installation's API root. Supply query values separately.
`signal` supports ordinary fetch cancellation and `headers` can be supplied
per call. An optional client `fetch` supplies a real alternate transport.

`NectarApiError` retains `status`, original parsed `body` or raw response text,
`version`, `headers` and the native error `code` when present. Early native
authentication refusals can omit the version header, yielding `null`. Network,
abort, redirect and JSON decoding failures propagate without a second request.

## Checkout links and portal sessions

Use these operations only from trusted server code with an existing native
owner member session. Never expose the owner's cookie, factor or SDK client
to a customer browser. Native authorization, configured fresh-factor checks,
reviewed tax, processor evidence and independent approval remain enforced by
Nectar. The SDK does not configure a processor or approve a link or portal host.

```ts
const links = await ownerClient.paymentLinks.list()
const created = await ownerClient.paymentLinks.create({
  name: 'Reviewed monthly workspace',
  kind: 'subscription',
  price: [existingNativePriceId],
  quantity: ['1'],
  months: 1,
  auto_renew: false,
  notice_days: 7,
  uplift_percent: '0',
  confirm: true,
  // Supply only after explicitly reviewing a native sole-owner confirmation.
  confirm_single: true,
}, { idempotencyKey: reviewedLinkRequestKey })

const session = await ownerClient.portal.sessions.issue({
  customer: internalCustomerId,
  origin: approvedPortalOrigin,
  audience: 'hosted',
}, { idempotencyKey: reviewedPortalRequestKey })
// Deliver session.url only to the intended customer through your private response.
// Never log the session, token, URL or complete successful response body.

await ownerClient.portal.sessions.revoke({ session: session.id }, {
  idempotencyKey: reviewedRevocationRequestKey,
})
```

`paymentLinks.list()` returns the native management array, including exact
frozen terms, current status, approval state and activation fact. The create
result contains `id`, relative `path` and `revision`; it does not establish
checkout completion. Subscription links can require an independent approval
and separate activation before their customer door is available.

Subscription creation supports native simple flat or seat monthly prices,
explicit renewal choices, trial days and an existing promotion code. Its hosted
provider flow collects a card through setup, then records the native customer
and subscription only after verified completion. It does not create another
processor subscription or establish recurring debit authority. A one-time
create uses `kind: 'one_time'`, `name`, `description`, exact string `amount`,
`taxable`, optional `max_uses` and explicit `confirm: true`; the existing hosted
payment flow purchases that exact one-time invoice after customer consent and
verified payment. These native flows currently require the configured test
processor account; the SDK does not claim unsupported production operation.

`portal.sessions.issue()` accepts an internal customer ID, an already approved
exact `origin` and `audience`. Embedded sessions additionally require the
approved exact `parent`. Its `token` and `url` are customer-scoped credentials;
`expiresAt` is epoch milliseconds. Do not log, publish, cache publicly or put
either credential in analytics. Revocation uses the returned session `id`.
The SDK never changes approved origins or creates new customer consent.

The [server sample](../../examples/typescript-sdk/README.md) resolves only the
native relative checkout path against the installation origin and exports an
explicit owner-invoked hosted portal helper. Returning a URL leaves customer
presentation and any redirect to the caller; the helpers do not follow it with
owner credentials or simulate a purchase or portal response.

## Maintenance

The source authority is [the native OpenAPI implementation](../../src/nectar/openapi.ts),
[API.md](../../API.md), [dated versions](../../src/nectar/api-versions.ts),
[usage](../../src/nectar/usage.ts), [entitlements](../../src/nectar/entitlements.ts)
and [metadata](../../src/nectar/metadata.ts), plus
[payment links](../../src/nectar/payment-links.ts) and
[portal session policy](../../src/nectar/portal-policy.ts). When a native schema changes,
update its resource module and examples together, compile both independent
projects, and exercise their public exports against the actual Nectar routes.
Keep transport policy in `src/transport.ts` and resource schemas in their
respective modules. The root application configuration does not need changes.
