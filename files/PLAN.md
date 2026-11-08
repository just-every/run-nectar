# sx-nectar-f25fix1 plan

Scope: only RPT-001 blocking B (item discounts lost on replacement subscription items) and blocking A (captured history omits mixed subscriptions filtered by a metered price). No campaign continuation, contract status/gap/evidence changes, redesign, Base refresh, release or publication scan.

1. Use a fresh full-history clone of just-every/run-nectar. Start cloud/sx-nectar-f25fix1 at c268e667a84603f091672ae9e743851fa8ed1a4f; merge current origin/main, preserving main's contract judgments and generated views. Resolve mechanical integration conflicts, renumber candidate migrations above main's maximum and update references.
2. Read the existing metric, adoption, subscription-change and regression-test paths. Reproduce both failures through existing public-door tests, adding at most one regression assertion per item to an existing file; preserve all existing assertions.
3. Fix replacement-item discount custody and metered-price history membership. Retain the existing builder CLAIM. Do not change CONTRACT.md status, gap or evidence cells or commit generated ACCEPTANCE.md/docs/CLAIMS.md.
4. Run touched tests and typecheck. Run generator write/check after the contract merge, restore origin/main's generated views, check/rebuild deployment spec if needed, regenerate source lock last and check it. Count tests before/after.
5. Commit with fleet identity and hooks. Inspect every unpublished author, committer, trailer and message. Push only cloud/sx-nectar-f25fix1 through the required push guard; save commits carry [skip ci]. Merge updated main after published saves, preserving published history.
6. Require exact-SHA Verify via REST within the ten-call budget, at most one poll per run per 300 seconds. Diagnose any failed job once via gh run view --log-failed. No full local verify or publication scan.
7. Save actual non-secret before/after, validation, integration, custody and CI receipts here. Publish the explicitly selected complete packet only to evidence/sx-nectar-f25fix1. Report branch, full SHA, exact CI IDs, counts, unchanged clause statuses, CLAIM and lane POST; conclude READY only when the exact-SHA Verify bar is satisfied.
