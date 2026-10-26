import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { operatorInstaller, developmentTarget, previewTarget } from '@runeditrun/rer/operator-installer';
import { selectLocalState } from '@runeditrun/rer/local/state';
import { commandAdapter as createCommandAdapter } from '@runeditrun/rer/adapter';
import { ownerDeploy } from '@runeditrun/rer/deploy';
import { localPortability } from '@runeditrun/rer/portability';
import * as model from './ui/seed.mjs';

export { selectLocalState };
const lifecycle = operatorInstaller({
 database: 'nectar', features: model.features,
 async prepare({ root, input, store }) {
  // export and import run prepare without answers; the saved branding stays.
  if (input.APP_NAME === undefined && input.PRIMARY_COLOR === undefined) return;
  await store.step('Saving application branding');
  await writeFile(join(root, 'src/branding.json'), JSON.stringify({ name: input.APP_NAME, primaryColor: input.PRIMARY_COLOR }, null, 2) + '\n');
 },
});
export const adapter = lifecycle;
export const { install } = lifecycle;
export const commandAdapter = createCommandAdapter(lifecycle, {
 dev: developmentTarget, preview: previewTarget, verify: ['pnpm', ['run', 'verify:app']], deploy: ownerDeploy('deploy.json', lifecycle),
 portability: localPortability({ database: 'nectar', policy: { excludeTables: ['nc_dunning_authority','nc_dunning_mail_authority','nc_retry_method_recovery_authorizations','nc_card_expiry_notice_authority','nc_portal_method_actions','nc_sso_config','nc_scim_users','nc_saml_transactions','nc_payment_link_activations','nc_payment_link_attempts','nc_automatic_collection_authorizations','nc_automatic_collection_events','nc_hosted_setups','nc_hosted_setup_returns','nc_trial_collections','nc_webhook_stripe_receipts','nc_webhook_subscription_revisions','nc_webhook_invoice_settlements','nc_webhook_entitlement_state','nc_webhook_observation_cursor','nc_webhook_attempts','nc_webhook_deliveries','nc_webhook_events','nc_webhook_endpoints','rer_dependency_keys','rer_dependency_pending','rer_dependency_codes','nc_guard','nc_privacy_context','nc_privacy_generation','nc_idempotency','nc_mfa_sessions','nc_mfa_challenges','nc_portal_sessions'], product: 'billing/nectar', requiredConfiguration: ['OWNER_EMAIL', 'SESSION_SECRET', 'SETUP_TOKEN', 'AUTH_ORIGIN', 'MAIL_PROVIDER', 'MAIL_FROM'] }, transient: ['local runtime caches and logs'] }),
 setup: { manifestFile: 'rer-setup.json' }, browserModule: 'scripts/installer/ui/seed.mjs',
 // The run site (rer build --site, rer deploy --site, RER_SITE): pages from
 // edition identity and Run data, written to an ignored folder; its domain is in deploy-site.json.
 site: { entry: 'src/site/pages.ts', output: 'dist/site', declaration: 'deploy-site.json' },
 // Local dev identity: the local-only Worker entry, the build output rer build
 // scans for the dev layer.
 devIdentity: { entry: 'src/server.dev.ts', output: ['dist'] },
 localOnlyKeys: ['RER_DEV_ORIGIN', 'RER_DEV_IDENTITY'],
 product: model.product.name, input: { names: { email: 'OWNER_EMAIL', name: 'displayName' }, async defaults(root) { const { readFile } = await import('node:fs/promises'); const branding = JSON.parse(await readFile(join(root, 'src/branding.json'), 'utf8')); return { APP_NAME: branding.name, PRIMARY_COLOR: branding.primaryColor }; } },
});
