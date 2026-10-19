// The local deterministic journey clock is a runtime binding, never customer input.
// Hosted installations always use the actual clock; the local runner supplies
// this binding only when advancing a disposable installation in a journey.
import { insist } from './core'
import type { Bindings } from '../auth.server'
export function clockInstant(env:Bindings):number {
  const value=(env as Bindings&{NECTAR_LOCAL_TIME?:string}).NECTAR_LOCAL_TIME
  if(env.AUTH_LOCAL!=='true'||value===undefined)return Date.now()
  insist(typeof value==='string'&&Number.isFinite(Date.parse(value)),'invalid_local_clock')
  return Date.parse(value)
}
