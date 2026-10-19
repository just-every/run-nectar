// Append-only replacements: metadata never enters money rows or rating inputs.
import type { Bindings } from '../auth.server'
import { actorLabel, requireMember, type Actor } from './actor'
import { all, commit, guard, insist, now, stmt } from './core'
import type { Input } from './input'
import { metadataRecord, metadataRecordGuard, type Metadata } from './metadata-records'

export { metadataFor, withMetadata } from './metadata-records'

export async function metadataView(env: Bindings, actor: Actor, kind: string, record: string) {
  const target = await metadataRecord(env, actor, kind, record)
  const revisions = await all<{ revision: number; metadata_json: string; author: string; created_at: number }>(env,
    'SELECT revision,metadata_json,author,created_at FROM nc_metadata_revisions WHERE kind=? AND record_id=? ORDER BY revision DESC', target.kind, target.id)
  const history = revisions.map(row => ({ revision: row.revision, metadata: JSON.parse(row.metadata_json) as Metadata, author: row.author, created_at: row.created_at }))
  return { ...target, revision: history[0]?.revision ?? 0, metadata: history[0]?.metadata ?? {}, history }
}

export async function writeMetadata(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor, 'records')
  input.only(['kind', 'record', 'revision', 'metadata', 'returnTo'])
  const target = await metadataRecord(env, actor, input.text('kind', { max: 20 }), input.text('record', { max: 100 }))
  const revision = input.integer('revision', { min: 0, max: Number.MAX_SAFE_INTEGER - 1 })
  insist(revision !== null, 'invalid_revision')
  const metadata = input.json('metadata')
  insist(metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata), 'invalid_metadata')
  insist(Object.getPrototypeOf(metadata) === Object.prototype || Object.getPrototypeOf(metadata) === null, 'invalid_metadata')
  const entries = Object.entries(metadata)
  insist(entries.length <= 50 && entries.every(([, value]) => typeof value === 'string'), 'invalid_metadata')
  // Do not trim, normalize or interpret keys/values, including special JS keys.
  const json = JSON.stringify(Object.fromEntries(entries)), by = actorLabel(actor), at = now()
  await commit(env, [
    metadataRecordGuard(env, target.kind, target.id),
    guard(env, 'stale', '(SELECT COALESCE(MAX(revision),0) FROM nc_metadata_revisions WHERE kind=? AND record_id=?)=?', target.kind, target.id, revision),
    stmt(env, 'INSERT INTO nc_metadata_revisions (kind,record_id,revision,metadata_json,author_id,author,created_at) VALUES (?,?,?,?,?,?,?)',
      target.kind, target.id, revision + 1, json, actor.id, by, at),
  ], { actor: by, action: 'metadata.replace', subject: target.id, detail: { kind: target.kind, revision: revision + 1, metadata: JSON.parse(json) } })
  return { ...target, revision: revision + 1, metadata: JSON.parse(json) as Metadata }
}
