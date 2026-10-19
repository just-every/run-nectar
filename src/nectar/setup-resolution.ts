// Human resolutions are new immutable proposals, never edits to the source.
import type { Bindings } from '../auth.server'
import { requireMember, type Actor } from './actor'
import { insist, one, parseJson, type Row } from './core'
import { Input } from './input'
import { propose } from './proposals'

export async function resolveSetup(env:Bindings,actor:Actor,input:Input) {
  requireMember(actor,'records')
  const row=await one(env,"SELECT * FROM nc_proposals WHERE id=? AND status='pending'",input.text('proposal',{max:100}))
  insist(row,'proposal_not_found',404)
  const payload=parseJson<Row>(row.payload_json,{})
  insist(payload.setup,'not_a_setup_proposal')
  const issues=(payload.input.ambiguities??[]) as Row[],values=input.list('resolution',{keepEmpty:true})
  insist(issues.length>0&&values.length===issues.length&&values.every(v=>v.length>0&&v.length<=2000),'setup_resolutions_required')
  return await propose(env,actor,Input.of({kind:'amendment',title:`Resolved: ${row.title}`.slice(0,200),payload:{...payload.input,revises:row.id,ambiguities:issues.map((a,index)=>({issue:a.issue,resolution:values[index]}))}}))
}
