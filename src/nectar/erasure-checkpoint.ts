import type { Bindings } from '../auth.server'
import { createPortability } from '@runeditrun/rer/modules/portability'
import type { D1Sql } from '../modules/import-kit/src/d1/index'
import { insist } from './core'
export async function privacyCheckpoint(env: Bindings): Promise<D1Sql[]> {
  const portability = await createPortability({ db: env.DB, policy: { product: 'billing/nectar', excludeTables: ['agent_door_%','bs_%','nc_billing_notice_authority','nc_dunning_authority','nc_dunning_mail_authority','nc_card_expiry_notice_authority','nc_portal_method_actions','nc_sso_config','nc_scim_users','nc_saml_transactions','nc_payment_link_activations','nc_payment_link_attempts','nc_automatic_collection_authorizations','nc_automatic_collection_events','nc_hosted_setups','nc_hosted_setup_returns','rer_dependency_keys','rer_dependency_pending','rer_dependency_codes','nc_guard','nc_privacy_context','nc_privacy_generation','nc_idempotency','nc_mfa_sessions','nc_mfa_challenges','nc_portal_sessions'] } })
  return [...await portability.redactionStatements(), ...await portability.invalidateTransfersStatements()].map(prepared => { const value=prepared as unknown as {statement:string;params:unknown[]}; insist(typeof value.statement==='string'&&Array.isArray(value.params),'invalid_privacy_checkpoint'); return {sql:value.statement,params:value.params} })
}
