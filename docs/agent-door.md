# Nectar's company agent door

Nectar adopts the declared CORE door: tools, policy, pause, audit and idempotency.
The production Worker routes it before authentication and setup redirects. Both
MCP eras use this same registry. Business policy governs its calls; native roles,
record visibility and person-only decisions remain authoritative.

The specialist is `billing-controller`: ingest usage, compare sender controls,
investigate assurance cases, answer questions from issued billing evidence and
prepare exact corrections for a person. External documents and all arbitrary
content are untrusted inputs. They never select the risk class or approver.

| Tool | Native service | Classes | Contract clauses |
| --- | --- | --- | --- |
| `nectar.usage.submit` | `submitUsage` | standard, sensitive when protected content is present | NEC-05, USE-001 |
| `nectar.controls.record` | `recordControl` | standard, sensitive when resolved content is protected | USE-007 |
| `nectar.assurance.scan` | `scanAssurance` | standard, sensitive when evidence is protected | AGENT-001, AGENT-010 |
| `nectar.assurance.recheck` | `recheckAssurance` | standard, sensitive when evidence is protected | AGENT-001, AGENT-009, AGENT-010 |
| `nectar.answers.get` | `billingAnswer` | standard, sensitive when saved evidence is protected | AGENT-007, PORT-001, PORT-002 |
| `nectar.answers.propose` | `proposeAnswerCredit` | standard, sensitive when saved evidence is protected | AGENT-007, NEC-14 |
| `nectar.corrections.preview` | `previewUsageCorrection` | standard, sensitive when saved evidence is protected | USE-004, AGENT-002 |
| `nectar.corrections.prepare` | `prepareUsageCorrection` | standard, sensitive when evidence or explanation is protected | USE-004, NEC-14, AGENT-002 |
| `nectar.meters.preview` | `previewMetric` (saves a preview) | standard, sensitive when source events are protected | USE-002 |
| `nectar.audit.list` | native audit projection (opaque references, no private detail) | standard | GOV-004 |

There are no public resource templates or resource links in this CORE candidate.
Resources, prompts, events and subscriptions are undeclared. Discovery and empty
listings describe that fact; calls receive typed `capability_not_declared`
refusals. Unknown native tools receive `tool_not_found`. No synthetic events tool
is registered. Internal door audit remains enabled.

Business subjects bind through signed `owner_id` and team `id` values to durable
operator IDs, then Nectar member IDs. The setup owner remains the native owner.
Business admins receive native Finance and Business editor authority; Business
members receive native Accountant and no policy-editing role. Native promotion
alone never changes the signed Business role. Current membership, operator
admission and native roles are re-read; token email cannot select a sponsor.
New application keys retain their native sponsor ID. Legacy prepare/usage keys
keep their existing API purpose, but require native reissue before admission to
the company door: their saved author email cannot establish a sponsor ID.
Neither scope acquires financial approval authority.

Nectar's setup manifest retains its native setup-token lifecycle, whose native endpoint is
`/auth/bootstrap`. The initializer posts the per-run setup credential to that
production bootstrap handler, then configures a real native business and reviews
its tax declaration through ordinary owner HTTP. The separate paired
`/auth/owner-claim` handler continues requiring its signed credential.
Fixtures create customers, catalog, events, subscriptions and issued invoices
through those same doors; they do not insert application data directly.

No custom provider edge is declared. These tools do not reach Stripe,
QuickBooks or a connector. Native proposal preparation may deliver configured
internal notifications through Base's built-in mail edge. Actual payment,
refund, ledger, provider-account and outbound customer-message tools are absent.
There is no `cost`, no spend reservation and no enforced spend cap;
`agent-surface.json` states `spend: {none:true}`.

## Difference from ct's draft

The input remains ct's unmerged draft at
`b8e7ade1caf5d86f4743df039057de595f7e09d9`,
`docs/contract/AGENT-SURFACE.md`. This change does not merge or rewrite it and
creates no `SURFACE-*` clause IDs. The ten tools above use its existing names.
The draft has 166 tools, 56 resource templates, 31 event types and eight prompt jobs. This candidate exposes ten tools, no public resource/event/prompt/subscription family, and 20 journey steps. The remaining 156 tool names are unregistered targets, not claims.

The native code explicitly requires a member, owner, fresh factor or native
session for financial decisions, access/security administration, meter activation,
policy authoring and actual customer/provider sends. Company approval cannot
turn the preparing agent into that person. Those jobs remain on their native
screens. Import, connector, device and installation operations retain the draft's
explicit `notTools` reasons. CORE does not claim multi-sponsor isolation, timed
or queued effects, mail delivery, resource refresh, or erasure of retained door
artifacts. Those families require separate native journeys and custody decisions.

Current sensitivity detection recognizes actual ID, card and bank-shaped
content; it is not a general health/payroll document classifier. Financial apply
and independent native decision journeys remain outside this candidate. In
particular, a prepared correction is still subject to the native financial
preparation and separate-person requirements. No native authority is fabricated.

GOV-005 is PARTIAL for the newly retained door artifacts. Native erasure only inventories `nc_*` tables; the new `agent_door_*` arguments, decisions, approvals and replay outcomes have no agreed client-scoped redaction and concurrent-capture fence. Base explicitly identifies that custody boundary as unresolved.

The production-build door check on rer 0.2.88 passed 1,702 of 1,704 points.
Both failures are `BASE-AGENT-005.5.autonomous.{plain,protected}-corrections-prepare`:
Base's injection harness generates a fresh write key after the first preparation,
then requires a second successful preparation. Native Nectar permits only one
pending correction per subscription (`nc_usage_correction_pending`). The shared
harness needs a replay-preserving injection or a native consumed-precondition
hook; the seed must retain that constraint. This is a READY-PENDING-BASE edge for
gr. Normal `rer verify` remains the final command, with its failure exit intact.

The full candidate remains PARTIAL for this conformance edge and the wider
native/custody gaps. The descriptor's journey is the declared proof obligation;
copying Base source is not proof of any clause.
