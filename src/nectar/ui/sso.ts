import type { Bindings } from '../../auth.server'
import { requireOwner, type Actor } from '../actor'
import { all } from '../core'
import { configureSso, ssoCallback, ssoConfig, ssoEntity } from '../sso-config'
import { Input } from '../input'
import { area, field, h, hidden, page, table, tag } from './html'

export async function ssoPage(env: Bindings, actor: Actor, url: URL, token?: string) {
  requireOwner(actor)
  const config = await ssoConfig(env), users = await all(env, 'SELECT s.email,s.source_role,s.active,m.role FROM nc_scim_users s JOIN nc_members m ON m.id=s.member_id ORDER BY s.email')
  return page('Enterprise sign-in', actor, h`<h1>Enterprise sign-in</h1><p><a href="/app/access">Back to Access</a></p>
    ${token ? h`<section class="card"><h2>Provisioning credential</h2><p>Copy it now. Nectar stores only its fingerprint. Saving new settings rotates it and ends existing enterprise sessions.</p><code class="credential">${token}</code></section>` : ''}
    <section class="card"><h2>Connect your identity provider</h2><p>Use these values in your SAML application.</p><dl><dt>Audience</dt><dd>${ssoEntity(env)}</dd><dt>Reply URL</dt><dd>${ssoCallback(env)}</dd><dt>Provisioning URL</dt><dd>${env.AUTH_ORIGIN}/scim/v2</dd><dt>Member sign-in</dt><dd><a href="/sso/start">Sign in with your provider</a></dd></dl>
    <form action="/app/sso" method="post">${hidden('revision', config?.revision ?? 0)}
    ${field('Provider issuer', 'issuer', { value: config?.issuer ?? '' })}${field('Provider sign-in URL', 'entry_point', { type: 'url', value: config?.entry_point ?? '' })}
    ${area('Signing certificate', 'certificate', config?.certificate ?? '', true, 7)}
    ${area('Role mappings', 'role_map', config?.role_map ?? '{"billing":"accountant"}', true, 3)}
    <p>Map provider roles to finance, accountant, collections, sales, support or developer. Existing accounts cannot be taken over. Provisioned members use their provider to sign in.</p>
    <button type="submit">Authorize connection</button></form></section>
    <section class="card"><h2>Provisioned members</h2>${table(['Email', 'Provider role', 'Nectar role', 'Access'], users.map(user => [user.email, user.source_role, user.role, tag(user.active ? 'Active' : 'Ended')]))}</section>`, { current: '/app/access', url })
}

export async function ssoPost(env: Bindings, actor: Actor, input: Input, url: URL) {
  const result = await configureSso(env, actor, input)
  return ssoPage(env, actor, url, result.scim_token)
}
