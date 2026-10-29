// Meter previews evaluate only projected customer/source events. Caller SQL is
// parsed into the same exact engine as a native meter, never executed in D1.
import type { Bindings } from '../auth.server'
import { requireRead, actorLabel, companyAgentDetail, requireCapability, requireMember, type Actor } from './actor'
import { all, commit, fingerprint, guard, insist, newId, now, one, parseJson, stmt, type Row } from './core'
import { isMonth, periodStartingIn, today, zonedStart } from './dates'
import { requireBusiness } from './business'
import type { Input } from './input'
import type { MetricEvent, MetricPlan, Predicate, PropertyValue } from './metric-plan'
import { aggregateMetric } from './metric-aggregate'
import { parseMeterSql } from './meter-sql'

const property=(v:unknown)=>{insist(typeof v==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,59}$/.test(v),'invalid_metric_property');return v}
export function eventProperties(value:unknown):Record<string,PropertyValue> {
  if(value===undefined)return {}
  insist(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length<=30,'invalid_event_properties')
  for(const [key,v] of Object.entries(value)) {
    property(key);insist(v===null||typeof v==='boolean'||typeof v==='string'&&v.length<=500||typeof v==='number'&&Number.isSafeInteger(v),'invalid_event_property')
  }
  return value as Record<string,PropertyValue>
}
function nativePlan(definition:unknown):MetricPlan {
  insist(definition&&typeof definition==='object'&&!Array.isArray(definition),'invalid_meter_definition')
  const d=definition as Row,aggregation=d.aggregation
  insist(['sum','count','maximum','unique','latest','time_weighted'].includes(aggregation),'invalid_aggregation')
  const groupBy=d.group_by??[];insist(Array.isArray(groupBy)&&groupBy.length<=5&&new Set(groupBy).size===groupBy.length,'invalid_group_by');groupBy.forEach(property)
  const plan:MetricPlan={aggregation,value:d.value_property?{kind:'property',name:property(d.value_property)}:{kind:'quantity'},groupBy}
  if(aggregation==='unique')plan.uniqueProperty=property(d.unique_property)
  if(aggregation==='time_weighted') {insist(['hour','month'].includes(d.time_unit),'invalid_time_unit');plan.timeUnit=d.time_unit;if(d.entity_property)plan.entityProperty=property(d.entity_property)}
  const filters=d.filters??[];insist(Array.isArray(filters)&&filters.length<=20,'invalid_metric_filters')
  for(const f of filters) {
    property(f.property);insist(['=','!=','<','<=','>','>='].includes(f.operator),'invalid_metric_filter')
    eventProperties({value:f.value});const predicate:Predicate={kind:'compare',operator:f.operator,left:{kind:'property',name:f.property},right:{kind:'literal',value:f.value}}
    plan.where=plan.where?{kind:'and',left:plan.where,right:predicate}:predicate
  }
  return plan
}

export async function metricEvents(env:Bindings,customer:string,source:string,before:number):Promise<(MetricEvent&{meterId:string;invoiceId:string|null})[]> {
  return (await all(env,"SELECT event_id,meter_id,quantity,occurred_at,properties_json,invoice_id FROM nc_usage_events WHERE customer_id=? AND meter_id=? AND status='active' AND NOT EXISTS(SELECT 1 FROM nc_usage_voids v WHERE v.event_id=nc_usage_events.event_id) AND occurred_at<? ORDER BY occurred_at,event_id",customer,source,before)).map(e=>({eventId:e.event_id,meterId:e.meter_id,quantity:e.quantity,occurredAt:e.occurred_at,properties:parseJson(e.properties_json,{}),invoiceId:e.invoice_id}))
}
export async function metricRequests(env:Bindings,actor:Actor) {
  requireRead(actor,'catalog')
  return await Promise.all((await all(env,'SELECT * FROM nc_metric_requests ORDER BY prepared_at,id')).map(async r=>({...r,plan:parseJson(r.plan_json,{}),plan_json:undefined,previews:(await all(env,'SELECT * FROM nc_metric_previews WHERE request_id=? ORDER BY prepared_at,id',r.id)).map(p=>({...p,result:parseJson(p.result_json,[]),result_json:undefined}))})))
}
export async function prepareMetric(env:Bindings,actor:Actor,input:Input) {
  requireMember(actor,'records')
  const code=input.text('code',{max:50}).toLowerCase();insist(/^[a-z0-9][a-z0-9_.-]{0,49}$/.test(code),'invalid_code')
  const source=await one(env,'SELECT * FROM nc_meters WHERE (id=? OR code=?) AND source_meter_id IS NULL',input.text('source_meter',{max:100}),input.text('source_meter',{max:100}));insist(source,'source_meter_not_found',404)
  const sql=input.text('sql',{max:16000,optional:true}),plan=sql?parseMeterSql(sql):nativePlan(input.has('definition')?input.json('definition'):{aggregation:input.text('aggregation',{max:30}),group_by:input.text('group_by',{max:300,optional:true}).split(',').map(s=>s.trim()).filter(Boolean),unique_property:input.text('unique_property',{max:60,optional:true}),entity_property:input.text('entity_property',{max:60,optional:true}),time_unit:input.text('time_unit',{max:10,optional:true}),value_property:input.text('value_property',{max:60,optional:true}),filters:input.has('filter_property')?[{property:input.text('filter_property',{max:60}),operator:input.text('filter_operator',{max:3}),value:input.text('filter_value',{max:500})}]:[]})
  const version=(await one(env,'SELECT COALESCE(MAX(metric_version),0)+1 AS next FROM nc_meters WHERE metric_key=?',code))!.next,id=newId()
  await commit(env,[stmt(env,"INSERT INTO nc_metric_requests(id,code,name,unit_label,source_meter_id,plan_json,sql_text,version,status,prepared_by,prepared_at) VALUES(?,?,?,?,?,?,?,?,'prepared',?,?)",id,code,input.text('name',{max:120}),input.text('unit_label',{max:40}),source.id,JSON.stringify(plan),sql,version,actorLabel(actor),now())],{actor:actorLabel(actor),action:'meter.prepare',subject:id,detail:{code,version,source:source.id,plan,sql}})
  return {request:id,version}
}
async function previewBasis(env:Bindings,request:Row,customer:string,month:string) {
  insist(isMonth(month),'invalid_period')
  const business=await requireBusiness(env);const period=periodStartingIn(1,month);insist(period.end<=today(business.timezone),'metric_preview_must_be_past')
  const c=await one(env,'SELECT id FROM nc_customers WHERE id=? OR external_id=?',customer,customer);insist(c,'customer_not_found',404)
  const from=zonedStart(period.start,business.timezone),to=zonedStart(period.end,business.timezone)
  const events=await metricEvents(env,c.id,request.source_meter_id,to),plan=parseJson<MetricPlan>(request.plan_json,null as never)
  const basis={customer:c.id,source:request.source_meter_id,plan,period,timezone:business.timezone,events:events.map(({invoiceId:_invoice,...e})=>e)}
  return {customer:c.id,fingerprint:await fingerprint(basis),result:aggregateMetric(plan,events,{from,to}),period,basis}
}
export async function previewMetric(env:Bindings,actor:Actor,input:Input) {
  requireCapability(actor,'read')
  const r=await one(env,'SELECT * FROM nc_metric_requests WHERE id=?',input.text('request',{max:100}));insist(r,'metric_request_not_found',404)
  const month=input.text('period',{max:7}),result=await previewBasis(env,r,input.text('customer',{max:100}),month),id=newId()
  await commit(env,[stmt(env,'INSERT INTO nc_metric_previews(id,request_id,customer_id,period,source_fingerprint,result_json,prepared_by,prepared_at) VALUES(?,?,?,?,?,?,?,?)',id,r.id,result.customer,month,result.fingerprint,JSON.stringify(result.result),actorLabel(actor),now())],{actor:actorLabel(actor),action:'meter.preview',subject:id,detail:{request:r.id,period:month,fingerprint:result.fingerprint,...companyAgentDetail(actor)}})
  return {preview:id,period:result.period,fingerprint:result.fingerprint,results:result.result}
}
export async function activateMetric(env:Bindings,actor:Actor,input:Input) {
  requireMember(actor,'records')
  const r=await one(env,'SELECT * FROM nc_metric_requests WHERE id=?',input.text('request',{max:100}));insist(r,'metric_request_not_found',404);insist(r.status==='prepared','metric_already_active',409)
  const previews=(await all(env,'SELECT * FROM nc_metric_previews WHERE request_id=? ORDER BY prepared_at DESC,id DESC',r.id)).filter((p,i,a)=>a.findIndex(q=>q.period===p.period&&q.customer_id===p.customer_id)===i)
  const chosen=previews.slice(0,3);insist(chosen.length===3&&new Set(chosen.map(p=>p.period)).size===3&&new Set(chosen.map(p=>p.customer_id)).size===1,'three_metric_previews_required',409)
  const sourceGuards:D1PreparedStatement[]=[]
  for(const p of chosen){const current=await previewBasis(env,r,p.customer_id,p.period);insist(current.fingerprint===p.source_fingerprint,'metric_preview_stale',409);const before=zonedStart(current.period.end,current.basis.timezone),ids=current.basis.events.map(e=>e.eventId);sourceGuards.push(guard(env,'metric_preview_stale',`(SELECT COUNT(*) FROM nc_usage_events WHERE customer_id=? AND meter_id=? AND status='active' AND NOT EXISTS(SELECT 1 FROM nc_usage_voids v WHERE v.event_id=nc_usage_events.event_id) AND occurred_at<?)=? AND NOT EXISTS(SELECT 1 FROM nc_usage_events WHERE customer_id=? AND meter_id=? AND status='active' AND NOT EXISTS(SELECT 1 FROM nc_usage_voids v WHERE v.event_id=nc_usage_events.event_id) AND occurred_at<? AND event_id NOT IN(SELECT value FROM json_each(?)))`,p.customer_id,r.source_meter_id,before,ids.length,p.customer_id,r.source_meter_id,before,JSON.stringify(ids)))}
  const id=newId(),code=`${r.code}.v${r.version}`
  await commit(env,[...sourceGuards,guard(env,'metric_already_active',"EXISTS(SELECT 1 FROM nc_metric_requests WHERE id=? AND status='prepared')",r.id),guard(env,'metric_version_stale','COALESCE((SELECT MAX(metric_version) FROM nc_meters WHERE metric_key=?),0)=?',r.code,r.version-1),stmt(env,"INSERT INTO nc_meters(id,code,name,unit_label,origin,revision,created_at,source_meter_id,metric_plan_json,metric_key,metric_version) VALUES(?,?,?,?,'native',?,?,?,?,?,?)",id,code,r.name,r.unit_label,newId(),now(),r.source_meter_id,r.plan_json,r.code,r.version),stmt(env,"UPDATE nc_metric_requests SET status='active',activated_by=?,activated_at=?,meter_id=? WHERE id=?",actorLabel(actor),now(),id,r.id)],{actor:actorLabel(actor),action:'meter.activate',subject:id,detail:{request:r.id,code,version:r.version,previews:chosen.map(p=>p.id),preparedBy:r.prepared_by}})
  return {id,code,version:r.version}
}
