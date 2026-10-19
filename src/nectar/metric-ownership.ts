import type { Bindings } from '../auth.server'
import { all, canonical, insist, parseJson } from './core'
import type { ItemIn } from './rating'
export async function sourceMeterIds(env:Bindings,ids:string[]) {
  if(!ids.length)return []
  return (await all(env,`SELECT id,COALESCE(source_meter_id,id) AS source FROM nc_meters WHERE id IN (${ids.map(()=>'?').join(',')})`,...ids)).map(m=>m.source as string)
}
/** Within the owner, metrics/dimensions may stack; the same selection may not. */
export async function uniqueMeterItems(env:Bindings,items:ItemIn[]) {
  const ids=[...new Set(items.map(i=>i.priceId))];if(!ids.length)return
  const prices=await all(env,`SELECT p.id,p.meter_id,p.dimensions_json FROM nc_prices p WHERE p.id IN (${ids.map(()=>'?').join(',')})`,...ids)
  for(const [index,item] of items.entries()) {
    const price=prices.find(p=>p.id===item.priceId);if(!price?.meter_id)continue
    for(const other of items.slice(0,index)) {
      const p=prices.find(p=>p.id===other.priceId)
      insist(!p||p.meter_id!==price.meter_id||canonical(parseJson(p.dimensions_json,{}))!==canonical(parseJson(price.dimensions_json,{}))||item.from>=(other.to??'9999')||other.from>=(item.to??'9999'),'meter_already_billed',409)
    }
  }
}
