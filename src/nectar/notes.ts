// Append-only customer context. All financial records remain untouched.
import type { Bindings } from '../auth.server'
import { operatorMail } from '../mail.server.mjs'
import { type RecordFamily, requireRead, requireAny, actorLabel, type Actor } from './actor'
import { all, commit, guard, insist, newId, now, one, stmt } from './core'
import type { Input } from './input'
import { customerNotes, noteRecord } from './note-records'
import { esc } from './ui/html'
import { memberPreferences } from './notifications'

/** Who may add notes: the owner and finance (records) or a role holding notes (GOV-001). */
function requireNoteAuthor(actor: Actor) {
  requireAny(actor, ['records', 'notes'])
  insist(actor.kind === 'member', 'person_required', 403)
}

const NOTE_FAMILIES: Record<string, RecordFamily> = { customer: 'customers', invoice: 'invoices', payment: 'payments' }
const requireNoteRead = (actor: Actor, kind: string) => { insist(kind in NOTE_FAMILIES, 'invalid_note_kind'); requireRead(actor, NOTE_FAMILIES[kind]) }

export async function noteMembers(env: Bindings, actor: Actor) {
  requireNoteAuthor(actor)
  return await all(env, "SELECT id,name,email FROM nc_members WHERE status='active' ORDER BY name,email")
}

export async function notes(env: Bindings, actor: Actor, kind: string, record: string) {
  requireNoteRead(actor, kind)
  const target = await noteRecord(env, kind, record)
  return (await customerNotes(env, target.customerId)).filter(n => n.kind === kind && n.record_id === record)
}

export async function addNote(env: Bindings, actor: Actor, input: Input) {
  requireNoteAuthor(actor)
  input.only(['kind','record','body','mention','returnTo'])
  const kind = input.text('kind', { max: 20 }), record = input.text('record', { max: 100 })
  requireNoteRead(actor, kind)
  const body = input.text('body', { max: 4000 })
  const target = await noteRecord(env, kind, record)
  const ids = [...new Set(input.list('mention'))]
  insist(ids.length <= 20, 'too_many_mentions')
  const members = []
  for (const id of ids) {
    const member = await one(env, "SELECT id,email FROM nc_members WHERE id=? AND status='active'", id)
    insist(member, 'mention_member_not_found', 400)
    members.push(member)
  }
  const id = newId(), at = now()
  await commit(env, [
    ...members.map(m => guard(env, 'stale', "EXISTS(SELECT 1 FROM nc_members WHERE id=? AND email=? AND status='active')", m.id, m.email)),
    stmt(env, 'INSERT INTO nc_notes (id,customer_id,kind,record_id,record_label,body,author_id,author,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id,target.customerId,kind,record,target.label,body,actor.id,actorLabel(actor),at),
    ...members.map(m => stmt(env, "INSERT INTO nc_note_mentions (note_id,member_id,email,status,updated_at) VALUES (?,?,?,'pending',?)", id,m.id,m.email,at)),
  ], { actor: actorLabel(actor), action: 'note.add', subject: id, detail: { customer: target.customerId, kind, record, mentions: ids } })
  await deliverMentions(env, id, actorLabel(actor), target.href)
  return { id: target.customerId, note: id }
}

/** A claimed delivery is never automatically retried after an uncertain send. */
async function deliverMentions(env: Bindings, noteId: string, by: string, href: string) {
  const note = await one(env, 'SELECT * FROM nc_notes WHERE id=?', noteId)
  if (!note) return
  const mentions = await all(env, "SELECT * FROM nc_note_mentions WHERE note_id=? AND status='pending'", noteId)
  for (const mention of mentions) {
    const claimed = await env.DB.prepare("UPDATE nc_note_mentions SET status='sending',updated_at=? WHERE note_id=? AND member_id=? AND status='pending' RETURNING member_id")
      .bind(now(),noteId,mention.member_id).first()
    if (!claimed) continue
    const member = await one(env, "SELECT email FROM nc_members WHERE id=? AND status='active' AND email=?",mention.member_id,mention.email)
    const mail = operatorMail(env)
    let status = 'failed', provider: string | null = null
    if (member && !(await memberPreferences(env,mention.member_id)).mentions) status = 'suppressed'
    else if (member && mail && env.MAIL_FROM) {
      const link = new URL(href, env.AUTH_ORIGIN).href
      const text = `${note.author} mentioned you on ${note.record_label}:\n\n${note.body}\n\n${link}`
      status = 'uncertain'
      try {
        const result = await mail.send({ deliveryId: `note-${noteId}-${mention.member_id}`, from: env.MAIL_FROM, to: [member.email],
          subject: `Mention on ${note.record_label}`, text, html: `<p>${esc(note.author)} mentioned you on ${esc(note.record_label)}:</p><pre>${esc(note.body)}</pre><p><a href="${esc(link)}">Open record</a></p>`, headers: { 'Auto-Submitted': 'auto-generated' } })
        status = result.status === 'accepted' ? 'accepted' : result.status === 'development' ? 'suppressed' : result.status === 'rejected' ? 'failed' : result.status
        provider = result.providerMessageId ?? null
      } catch { status = 'uncertain' }
    }
    await commit(env, [stmt(env, 'UPDATE nc_note_mentions SET status=?,provider_ref=?,updated_at=? WHERE note_id=? AND member_id=?', status,provider,now(),noteId,mention.member_id)],
      { actor: by, action: 'note.mention', subject: noteId, detail: { member: mention.member_id, status, provider } })
  }
}
