// Existing card/form vocabulary; notes travel with their customer and record.
import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import { formatInstant } from '../dates'
import { customerNotes } from '../note-records'
import { requireBusiness } from '../business'
import { payments } from '../receivables'
import { noteMembers } from '../notes'
import { area, check, form, h, hidden } from './html'

export async function notesSection(env: Bindings, actor: Actor, customer: string, kind: 'customer' | 'invoice', record: string, returnTo: string) {
  const rows = (await customerNotes(env, customer)).filter(n => kind === 'customer' || (n.kind === kind && n.record_id === record))
  const writable = actor.kind === 'member' && can(actor, 'records')
  const members = writable ? await noteMembers(env, actor) : []
  const business = await requireBusiness(env)
  const paymentRows = kind === 'customer' && writable ? await payments(env, actor, customer) : []
  const editor = (targetKind: string, target: string) => form('note.add', returnTo, h`${hidden('kind',targetKind)}${hidden('record',target)}${area('Note','body','',true,3)}
    ${members.length ? h`<fieldset><legend>@-mention colleagues (email notification)</legend>${members.map(m => check(`${m.name} (${m.email})`,'mention',{ value:m.id }))}</fieldset>` : ''}`, 'Add note', { secondary:true })
  return h`<section class="card" aria-labelledby="notes"><h2 id="notes">Notes</h2><p class="hint">Notes are dated and kept unchanged. Add a follow-up to correct or update one.</p>
    ${rows.length ? rows.map(n => h`<article class="change"><h3>${n.record_label}</h3><p class="hint">${n.author} · ${formatInstant(n.created_at,business.timezone)}</p><pre class="message">${n.body}</pre>
      ${n.mentions.length ? h`<ul>${n.mentions.map((m: any) => h`<li>@${m.email}: ${m.status === 'accepted' ? 'Email accepted by provider' : m.status === 'suppressed' ? 'Email suppressed in local development' : `Email ${m.status}`}</li>`)}</ul>` : ''}</article>`) : h`<p class="empty">No notes yet.</p>`}
    ${writable ? editor(kind,record) : ''}
    ${paymentRows.map(p => h`<details><summary>Add a note to payment ${p.reference}</summary>${editor('payment',p.id)}</details>`)}</section>`
}
