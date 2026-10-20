import type { Bindings } from '../auth.server'
import { requireRead, actorLabel, requireMember, type Actor } from './actor'
import { all, commit, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import type { Input } from './input'
import { csvResponse } from './report-csv'
import type { Report } from './reports'

export async function setReportSchedule(env: Bindings, actor: Actor, input: Input) {
  requireMember(actor,'export')
  requireRead(actor,'reports')
  input.only(['enabled','day','returnTo'])
  const enabled = input.flag('enabled'), day = input.integer('day',{min:1,max:28})!
  await commit(env,[stmt(env,`INSERT INTO nc_report_schedules(member_id,enabled,day,revision,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(member_id) DO UPDATE SET enabled=excluded.enabled,day=excluded.day,revision=excluded.revision,updated_at=excluded.updated_at`,
    actor.id,enabled?1:0,day,newId(),now())],{actor:actorLabel(actor),action:'report.schedule',subject:actor.id,detail:{enabled,day}})
  return (await reportSchedule(env,actor)).schedule
}
export async function reportSchedule(env: Bindings, actor: Actor) {
  requireMember(actor,'export')
  requireRead(actor,'reports')
  const schedule = await one(env,'SELECT enabled,day FROM nc_report_schedules WHERE member_id=?',actor.id)
  return {schedule:schedule?{...schedule,enabled:!!schedule.enabled}:{enabled:false,day:1},deliveries:await all(env,
    'SELECT id,period,status,provider_ref,generated_at FROM nc_report_deliveries WHERE member_id=? ORDER BY period DESC LIMIT 100',actor.id)}
}
export async function reportDelivery(env: Bindings, actor: Actor, id: string): Promise<Row & {reports:Report[]}> {
  requireMember(actor,'export')
  requireRead(actor,'reports')
  const row=await one(env,'SELECT * FROM nc_report_deliveries WHERE id=? AND member_id=?',id,actor.id)
  insist(row,'report_delivery_not_found',404)
  return {...row,reports:parseJson<Report[]>(row.reports_json,[]),sourceEvidence:parseJson<Row[]>(row.sources_json,[]),reports_json:undefined,sources_json:undefined,member_id:undefined}
}
export async function reportDeliveryCsv(env: Bindings, actor: Actor, id: string) {
  const delivery=await reportDelivery(env,actor,id)
  insist(delivery.csv!==null,'report_not_ready',409)
  return csvResponse(delivery.csv,`nectar-financial-${delivery.period}`)
}
