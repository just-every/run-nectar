import type { Bindings } from '../../auth.server'
import { requireOwner, type Actor } from '../actor'
import { all } from '../core'
import { configureSso, ssoCallback, ssoConfig, ssoEntity } from '../sso-config'
import { pendingLinks } from '../sso-linking'
import { Input } from '../input'
import { area, field, form, h, hidden, page, table, tag } from './html'

export async function ssoPage(env: Bindings, actor: Actor, url: URL, token?: string) {
  requireOwner(actor)
  const config = await ssoConfig(env), users = await all(env, 'SELECT s.email,s.source_role,s.active,m.role FROM nc_scim_users s JOIN nc_members m ON m.id=s.member_id ORDER BY s.email')
  const links = await pendingLinks(env, actor)
  return page('Enterprise sign-in', actor, h`<h1>Enterprise sign-in</h1><p><a href="/app/access">Back to Access</a></p>
    ${token ? h`<section class="card"><h2>Provisioning credential</h2><p>Copy it now. Nectar stores only its fingerprint. Saving new settings rotates it and ends existing enterprise sessions.</p><code class="credential">${token}</code></section>` : ''}
    <section class="card"><h2>Connect your identity provider</h2><p>Use the immutable provider user ID as NameID, with email, role and actual session amr attributes.</p><dl><dt>Audience</dt><dd><code>${ssoEntity(env)}</code></dd><dt>Reply URL</dt><dd><code>${ssoCallback(env)}</code></dd><dt>Provisioning URL</dt><dd><code>${env.AUTH_ORIGIN}/scim/v2</code></dd><dt>Member sign-in</dt><dd><a href="/sso/start">Sign in with your provider</a></dd></dl>
    <form action="/app/sso" method="post">${hidden('revision', config?.revision ?? 0)}
    ${field('Provider issuer', 'issuer', { value: config?.issuer ?? '' })}${field('Provider sign-in URL', 'entry_point', { type: 'url', value: config?.entry_point ?? '' })}
    ${area('Signing certificate', 'certificate', config?.certificate ?? '', true, 7)}
    ${area('Role mappings', 'role_map', config?.role_map ?? '{"billing":"accountant"}', true, 3)}
    <p>Map provider roles to finance, accountant, collections, sales, support or developer. Existing accounts cannot be taken over. Provisioned members use their provider to sign in.</p>
    <button type="submit">Authorize connection</button></form></section>
    <section class="card"><h2>Existing member requests</h2><p>Review the member, immutable provider subject, connection revision and unchanged role. Confirm your second factor before approving; the proof expires within five minutes. Approval ends every old member session.</p>
    ${links.map(link => h`<article><h3>${link.member.email}</h3><dl><dt>Provider issuer</dt><dd>${link.member.issuer}</dd><dt>Provider subject</dt><dd>${link.subject}</dd><dt>Connection revision</dt><dd>${link.member.configRevision}</dd><dt>Current Nectar role</dt><dd>${link.member.role}</dd><dt>Provider role</dt><dd>${link.sourceRole}</dd></dl>${form('sso.link.approve', '/app/sso', h`${hidden('link', link.id)}${hidden('basis', link.basis)}`, 'Approve member link')}</article>`)}
    ${links.length ? '' : h`<p>No current requests.</p>`}<p><a href="/app/security?returnTo=%2Fapp%2Fsso">Confirm your second factor</a></p></section>
    <section class="card"><h2>Provisioned members</h2>${table(['Email', 'Provider role', 'Nectar role', 'Access'], users.map(user => [user.email, user.source_role, user.role, tag(user.active ? 'Active' : 'Ended')]))}</section>`, { current: '/app/access', url })
}

export async function ssoPost(env: Bindings, actor: Actor, input: Input, url: URL) {
  const result = await configureSso(env, actor, input)
  return ssoPage(env, actor, url, result.scim_token)
}
