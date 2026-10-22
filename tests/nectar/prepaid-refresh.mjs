// USE-006 parity inside push Verify: the existing prepaid journeys call the
// refresh assertion after every committed ledger transition and the automatic
// funding, so grant, drawdown, rollover, expiry and top-up are each read back
// through the operator page and JSON door within the one-minute bound.
import assert from 'node:assert/strict'
import { prepaidFlow } from './prepaid.mjs'
import { prepaidTopupFlow } from './prepaid-topup.mjs'
import { prepaidRefreshParity } from './prepaid-report-parity.mjs'

export { harnessOptions } from './prepaid-topup.mjs'

export async function prepaidRefreshLedgerFlow(h,owner) {
  const samples=[]
  await prepaidFlow(h,owner,{onRefresh:async row=>samples.push(await prepaidRefreshParity(h,owner,row))})
  for(const kind of ['grant','drawdown','expiry','rollover'])assert.ok(samples.some(sample=>sample.entryKinds.includes(kind)),`Refresh parity covers ${kind}`)
}

export async function prepaidRefreshTopupFlow(h,owner) {
  let funded=0
  await prepaidTopupFlow(h,owner,{onState:async state=>{if(state.label==='funded'){funded++;await prepaidRefreshParity(h,owner,state.row)}}})
  assert.equal(funded,1,'Refresh parity covers the automatic top-up funding')
}
