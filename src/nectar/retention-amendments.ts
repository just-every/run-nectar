import type { Bindings } from '../auth.server'
import { stmt } from './core'

/** The scope and its approved discount enter the same acceptance transaction.
 * Native ownership columns also make this relation discoverable by erasure. */
export function retentionScopeStatements(env: Bindings, amendment: string, subscription: string, price: string | null) {
  return price ? [stmt(env, 'INSERT INTO nc_amendment_scopes(amendment_id,customer_id,subscription_id,price_id) SELECT ?,customer_id,id,? FROM nc_subscriptions WHERE id=?', amendment, price, subscription)] : []
}
