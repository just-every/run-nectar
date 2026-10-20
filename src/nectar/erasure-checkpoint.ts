import type { Bindings } from '../auth.server'
import { createPortability } from '@runeditrun/rer/modules/portability'
import type { D1Sql } from '../modules/import-kit/src/d1/index'
import { insist } from './core'
export async function privacyCheckpoint(env: Bindings): Promise<D1Sql[]> {
  const portability = await createPortability({ db: env.DB, policy: { product: 'billing/nectar', excludeTables: ['rer_dependency_keys','rer_dependency_pending','rer_dependency_codes','nc_guard','nc_privacy_context','nc_privacy_generation','nc_idempotency'] } })
  return [...await portability.redactionStatements(), ...await portability.invalidateTransfersStatements()].map(prepared => { const value=prepared as unknown as {statement:string;params:unknown[]}; insist(typeof value.statement==='string'&&Array.isArray(value.params),'invalid_privacy_checkpoint'); return {sql:value.statement,params:value.params} })
}
