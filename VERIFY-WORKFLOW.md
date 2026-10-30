# Adopt the seed Verify workflow

Foundation compositions and standalone reference exports receive the two
workflows from Base's export templates, the verification manifest and its
helpers. Existing editions merge these changes into their owned workflows,
preserving product checks, package pins and the stable `verify` aggregate.

| Entry | Coverage |
| --- | --- |
| Branch push, pull request, Verify dispatch | Push shards, unless qualified reuse or light coverage applies |
| Monday and Thursday schedule | Nightly shards only |
| Release tag beginning with `v` | Every push and nightly shard, always |
| Nightly journeys dispatch | Every push and nightly shard |

Verify retains unrestricted branch pushes and pull requests. Main's concurrency
key contains its run ID, so main runs cannot replace one another. Other refs
cancel superseded runs. Event names separate PR planning from its branch push
producer and separate scheduled and manual runs.

The workflows use Ubuntu 24.04. Keep that image and the edition's exact Node,
pnpm and frozen lockfile pins. The final aggregate requires successful planning
and the selected coverage. It accepts a skipped matrix only when the planner
explicitly selected reuse, light coverage, or an empty nightly selection. Failed
and cancelled work cannot pass the aggregate.

## Declare coverage

The verification manifest has `push` and `nightly` arrays. Each shard has a unique
`name`, boolean `browser` and `hosted` fields, and nonempty shell `commands`.
Exactly one push shard must be hosted. That shard retains RER's hosted-output
and hydration checks; every other shard uses the app verification path.

Inspect selections from a delivered checkout:

```sh
node scripts/verify-ci.mjs --matrix push
node scripts/verify-ci.mjs --matrix nightly
node scripts/verify-ci.mjs --matrix all
```

Run a named shard with `node scripts/verify-ci.mjs NAME`. Local `rer verify`
retains both arrays. Moving whole slow installer and README journey files to
nightly changes scheduling, not local or release coverage. Empty nightly arrays
produce an empty selection and skip matrix expansion safely.

## Push evidence and integration trees

The planner uses the current numeric workflow ID, workflow name, repository ID,
repository name and exact commit SHA. Only another eligible push of that SHA
can supply evidence. It selects the newest eligible push before inspecting its
latest attempt and jobs. A newer failed, cancelled or incomplete push defeats
an older green one. PRs, schedules and subset dispatches never supply push
proof, even when their aggregates are green.

A branch push produces `full-push-proof` only after full push coverage succeeds.
Light and reused runs do not produce it. Tags cannot produce it. Reuse requires
that proof, successful planning, every required push shard and the successful
aggregate from the latest attempt. A green aggregate with skipped tests alone
proves nothing. Skipped optional jobs are permitted; required jobs must succeed.

A same-repository PR waits for its head branch's producer for a bounded period
within the existing planning deadline. Missing or inaccessible evidence, lookup
errors, a failed or cancelled producer, or an expired wait selects full coverage.
Fork PRs run fully. The API run identity, PR head SHA and runner's tested merge
SHA are handled separately. Both commits must be identifiable and have equal
Git trees before head-push evidence can replace integration testing. A different
or ambiguous merge tree runs fully.

A child with one direct parent can reuse that parent's newest full push proof
only when their Git trees match. The planner never searches earlier ancestors.
Multiple parents, uncertain identities or incomplete comparisons run fully.
Every API listing must be complete and stable, with distinct valid entries;
partial pages, changing totals, authentication errors, redirects, rate limits,
invalid JSON and request timeouts select verification.

Base's existing `--main-skip` command and output remain available for its legacy
workflow while its CI packing is adopted separately. That compatibility path
retains its existing complete-job policy. The seed templates use `--plan` and
the explicit branch-only proof described here.

## Light coverage

Light selection requires a single direct parent with successful full push proof
and a complete local Git diff containing only these exact root documents or
paths beneath the two evidence directories:

```text
sources.lock.json
CONTRACT.md
ACCEPTANCE.md
CLAIMS.md
HANDOVER.md
STATUS.md
evidence/**
.artifacts/**
```

Both sides of renames count. Code changes, unverified parents, merge commits,
missing authoring prerequisites and uncertain diffs select full coverage.
Executable, configuration or unknown evidence formats also select full
coverage. The initial evidence formats are Markdown, text, PNG, JPEG and PDF.
This does not exempt files from source integrity or publication checks.

The explicit reader table in the light helper describes the maintained
reference and foundation tests and package commands. Unknown commands or test
readers select full coverage. Keep the table aligned with adopting tests; do
not infer arbitrary dependencies or exempt unknown readers. The maintained
runtime, auth, setup and installer tests have no direct semantic dependencies
on the permitted documents. Contract consistency is checked explicitly.

An edition declares additional reviewed readers in `verification.json`, beside
`push` and `nightly`:

```json
"readers": {
  "tests/product-contract.test.mjs": ["CONTRACT.md", "STATUS.md"]
}
```

Each key is a test path (or the exact test glob used in a shard command); its
value lists the repository-relative files that test reads semantically. An
empty array declares that it reads none of the permitted light inputs. A
declaration replaces the maintained entry for that same test, so editions that
adapt a maintained test must also review its dependencies. When a listed file
changes, light coverage runs that test through Node's test runner. Missing
tests, malformed declarations and undeclared tests still select full coverage.
The table does not expand the permitted light inputs or supported command forms.

Light coverage performs the edition source-lock validation, `rer check`, all
selected existing reader tests, generated contract-document consistency when a
contract document changed, and `rer build --site`. Source-lock validation is
mandatory: a candidate missing its edition manifest, lock or authoring helper
cannot select light. CI never updates the source lock. Intentional edits are
locked locally before pushing.

## Twice-weekly schedule and nightly markers

Generation hashes the seed name deterministically and maps it to one minute
between 02:00 and 07:59 UTC. It writes one static Monday and Thursday cron. Foundation
initialization and reference export use the same renderer. When selecting an
older pinned Base revision, initialization still takes that revision's workflow
bytes and helpers, then applies this schedule transformation. The final hash,
original source path and transformation are recorded in the foundation lock.
Reference provenance records the transformation too. This is a rendered copy,
not a claim that the original nightly bytes were copied unchanged.

The cache restore action uses lookup-only mode for `nightly-green-<full-sha>`;
it does not download a marker. Only main's scheduled or manual complete nightly
coverage can save it, after every selected shard succeeds. Branches and PRs
cannot produce trusted markers. Tags always run all coverage and bypass lookup.

An immutable marker is only a hint. Before skipping nightly work, the planner
requires the newest same-workflow scheduled or manual main run at that SHA to
have a successful latest attempt, complete nightly shards, `nightly-proof` and
aggregate. A newer failure defeats an old marker. Reused, empty or partial
nightly selections cannot manufacture a marker.

## Browser and cache setup

Prepare the runner-owned browser and apt archive directories under runner temp
before cache restore or sudo. Restore frozen dependency and browser caches,
install dependencies and prepare RER tools. Browser shards then:

1. Run `playwright install chromium` as the runner.
2. Launch Chromium and close it.
3. Only after launch failure, invoke the existing bounded system-dependencies
   helper and probe again.

Permission errors fail explicitly and do not trigger apt repair. Browser install
errors also fail immediately. The existing bounded apt helper, ownership
handling and EACCES refusal remain in place. Never repair the owner's HOME cache
silently or treat a permission failure as a successful skip. Nonbrowser shards
do not install Chromium. Native browser journeys retain bounded disk reclaim,
checking free space before each deletion and stopping at 20 GiB.

## Adoption checks

Deliver every imported verification helper alongside the entry point; refresh
maintained mirrors with `node foundation/verify-schedule.mjs --mirrors` after
source edits settle. The browser system-dependencies helper must come from the
same pinned revision as its workflow.

Run actionlint on workflows and run the helper's `--check-workflows` command.
Every caller must grant `contents: read` and `actions: read` to the job calling
Verify. A reusable workflow cannot increase its caller's token permissions;
actionlint alone does not catch that rejection. The helper tests retain both
checks and exercise planning through GitHub HTTP responses and real Git trees.

Adoption proof names the exact SHA, API head identity and tested merge ref
separately. A PR result remains a PR result. Preserve product journeys and
edition-owned source-lock checks when merging the template.
