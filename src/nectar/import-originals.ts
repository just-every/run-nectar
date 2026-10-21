// MOVE-007 / NEC-15: untrusted provider bytes remain owner-only custody.
import type { Bindings } from '../auth.server'
import { canonicalJson, readD1ImportOriginals, sha256, type D1ImportContext, type RetainedOriginal } from '../modules/import-kit/src/d1/index'
import { actorLabel, requireOwner, type Actor } from './actor'
import { commit, guard, insist, NectarError, one } from './core'
import { nectarTargets } from './movein/target'

export const importOriginalFileId = (original: Pick<RetainedOriginal, 'kind' | 'key'>) => sha256(canonicalJson([original.kind, original.key]))

function ownerAuthority(actor: Actor) {
  return { sql: `EXISTS(SELECT 1 FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id
    JOIN nc_members m ON m.id=? AND m.email=lower(o.email)
    WHERE s.id=? AND s.revoked_at IS NULL AND s.expires_at>CAST(strftime('%s','now') AS INTEGER)*1000
    AND o.version=s.operator_version AND o.status='active' AND o.role='owner' AND m.status='active' AND m.role='owner')`,
  params: [actor.id, actor.sessionId] }
}

async function retainedFiles(env: Bindings, actor: Actor, jobId: string) {
  requireOwner(actor)
  const authority = ownerAuthority(actor)
  insist((await one(env, `SELECT (${authority.sql}) AS allowed`, ...authority.params))?.allowed, 'owner_required', 403)
  insist(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(jobId), 'import_job_not_found', 404)
  // This monotonic counter covers plans, bytes, metadata and privacy rewrites.
  // Capture it before the kit reads, then fence it with the download audit.
  const job = await one(env, `SELECT j.principal_id,j.destination,j.namespace,j.mapping_version,c.revision
    FROM ik_jobs j LEFT JOIN ik_d1_custody_states c ON c.job_id=j.id WHERE j.id=?`, jobId)
  if (!job) {
    insist(!await one(env, "SELECT 1 FROM ik_d1_retirements WHERE id=? AND kind='job'", jobId), 'import_original_unavailable', 410)
    throw new NectarError('import_job_not_found', 404)
  }
  insist(job.destination === 'billing' && job.namespace === 'stripe' && job.mapping_version === 'stripe-billing-1', 'import_job_not_found', 404)
  insist(Number.isSafeInteger(job.revision), 'original_custody_changed', 409)
  const context: D1ImportContext = {
    destination: job.destination, namespace: job.namespace, mappingVersion: job.mapping_version,
    storage: { database: env.DB as never, targets: nectarTargets },
    // The kit binds custody to its importing principal. Access authority is
    // independently the current owner, including a finance-created import.
    authorization: { principalId: job.principal_id, predicate: () => authority },
  }
  let originals: RetainedOriginal[]
  try { originals = await readD1ImportOriginals(jobId, context) }
  catch {
    insist((await one(env, `SELECT (${authority.sql}) AS allowed`, ...authority.params))?.allowed, 'owner_required', 403)
    insist(!await one(env, "SELECT 1 FROM ik_d1_retirements WHERE id=? AND kind='job'", jobId), 'import_original_unavailable', 410)
    throw new NectarError('original_custody_changed', 409)
  }
  return { originals, authority, job }
}

/** Safe owner-only download selectors; no retained content enters a page. */
export async function importOriginalFiles(env: Bindings, actor: Actor, jobId: string) {
  const { originals } = await retainedFiles(env, actor, jobId)
  return originals.map(original => ({ id: importOriginalFileId(original), name: original.name, sha256: original.sha256,
    size: original.size, available: original.original.status === 'retained' }))
}

export async function downloadImportOriginal(env: Bindings, actor: Actor, request: Request, parts: readonly string[]): Promise<Response> {
  requireOwner(actor)
  insist(request.method === 'GET', 'method_not_allowed', 405)
  const [jobId, fileId] = parts
  insist(parts.length === 2 && /^[a-f0-9]{64}$/.test(fileId ?? ''), 'import_original_not_found', 404)
  const { originals, authority, job } = await retainedFiles(env, actor, jobId ?? '')
  const original = originals.find(value => importOriginalFileId(value) === fileId)
  insist(original, 'import_original_not_found', 404)
  insist(original.original.status === 'retained', 'import_original_unavailable', 410)
  const bytes = Uint8Array.from(atob(original.original.base64), character => character.charCodeAt(0))
  // The kit has validated exact bytes, size and digest. No provider JSON is
  // parsed or rendered by this handler, including malicious uploaded HTML.
  try {
    await commit(env, [
      guard(env, 'owner_required', authority.sql, ...authority.params),
      guard(env, 'original_custody_changed', `EXISTS(SELECT 1 FROM ik_jobs j JOIN ik_d1_custody_states c ON c.job_id=j.id
        WHERE j.id=? AND c.revision=? AND j.principal_id=? AND j.destination=? AND j.namespace=? AND j.mapping_version=?)
        AND NOT EXISTS(SELECT 1 FROM ik_d1_retirements WHERE id=? AND kind='job')`, jobId, job.revision, job.principal_id, job.destination, job.namespace, job.mapping_version, jobId),
    ], { actor: actorLabel(actor), action: 'import.original.download', subject: jobId!,
      detail: { file: fileId, sha256: original.sha256, size: original.size } })
  } catch (error) {
    if (error instanceof NectarError && error.code === 'owner_required') throw new NectarError('owner_required', 403)
    throw error
  }
  const digest = btoa(String.fromCharCode(...Uint8Array.from(original.sha256.match(/../g)!, value => parseInt(value, 16))))
  return new Response(bytes, { headers: {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="import-original-${fileId}.bin"`,
    'content-length': String(bytes.length), 'content-digest': `sha-256=:${digest}:`,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox", 'referrer-policy': 'no-referrer',
  } })
}
