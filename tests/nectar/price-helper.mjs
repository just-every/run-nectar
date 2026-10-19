import assert from 'node:assert/strict'
import { reviewer } from './policy-helper.mjs'

export async function publishPrice(h, owner, payload) {
  const result = await h.api('price.create', owner, payload)
  if (result.id) return result // V1 remains the initial catalogue setup door.
  assert.equal(result.status, 'pending')
  const request = (await h.api('catalog', owner)).priceRequests.find(r => r.id === result.request)
  const approver = await reviewer(h, owner, request.singleAllowed)
  return await h.api('price.decide', approver, { request: result.request, decision: 'approved', confirm_single: request.singleAllowed })
}
