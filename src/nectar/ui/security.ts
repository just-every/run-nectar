// GOV-007 Sign-in security: a member enrolls an authenticator app or a passkey,
// keeps one-time recovery codes, confirms it is them (at sign-in and again for
// sensitive actions) and removes their own factors.
import type { Bindings } from '../../auth.server'
import { safeReturnTo } from '../../modules/operator-auth/index.mjs'
import type { Actor } from '../actor'
import { business } from '../business'
import type { Input } from '../input'
import { KEY_REASONS, confirmTotp, mfaView, startTotp, verifyFactor } from '../mfa'
import { failure } from '../http'
import { field, form, h, hidden, page, table, tag, when, type Html } from './html'

const returnOf = (value: string | null | undefined) => safeReturnTo(value || '/app', '/app')

const codesCard = (codes: string[] | null): Html => codes ? h`<section class="card" aria-labelledby="codes"><h2 id="codes">Recovery codes</h2><p>Each code signs you in once if you lose your authenticator. Copy them somewhere safe now; Nectar keeps only their fingerprints and cannot show them again.</p><ol class="recovery-codes">${codes.map(code => h`<li><code>${code}</code></li>`)}</ol></section>` : h``

export async function securityPage(env: Bindings, actor: Actor, url: URL, extra: Html = h``, status = 200): Promise<Response> {
  const view = await mfaView(env, actor)
  const zone = (await business(env))?.timezone ?? 'UTC'
  const returnTo = returnOf(url.searchParams.get('returnTo'))
  const passkeys = view.factors.some(f => f.kind === 'passkey' && f.usable)
  const usable = view.factors.some(f => f.usable)
  const held = view.state === 'enroll'
    ? h`<p class="flash error" role="alert">${view.required ? 'The owner requires a second factor for your role. ' : ''}Enroll an authenticator app or a passkey before you can open anything else.${view.reason ? h` ${KEY_REASONS[view.reason]}` : ''}</p>`
    : view.state === 'verify' ? h`<p class="flash error" role="alert">Confirm it’s you with your second factor before you can open anything else.</p>` : h``
  const confirm = usable ? h`<section class="card" aria-labelledby="confirm"><h2 id="confirm">Confirm it’s you</h2><p class="hint">Sensitive actions (credits, access, credentials and the move-in cutover) ask again once your last check is more than ${view.step_up_minutes} minutes old.${view.verified_at ? ` Last confirmed ${when(view.verified_at, zone)}.` : ''}</p>
    <form method="post" action="/app/security/verify" class="columns">${hidden('returnTo', returnTo)}${field('Authenticator or recovery code', 'code', { hint: 'Six digits from your authenticator app, or one unused recovery code.' })}<button type="submit">Confirm</button></form>
    ${passkeys ? h`<p><button type="button" class="secondary" data-passkey="verify" data-return-to="${returnTo}">Use a passkey</button></p>` : ''}</section>` : h``
  const enrollable = !usable || view.verified_at !== null
  const add = enrollable ? h`<section class="card" aria-labelledby="add"><h2 id="add">Add a second factor</h2>
    <form method="post" action="/app/security/totp" class="columns">${hidden('returnTo', returnTo)}${field('Authenticator app name', 'label', { value: 'Authenticator app', required: false })}<button type="submit">Set up an authenticator app</button></form>
    <div class="columns">${field('Passkey name', 'passkey-label', { value: 'Passkey', required: false })}<button type="button" data-passkey="register" data-return-to="${returnTo}">Add a passkey</button></div></section>` : h``
  const factors = h`<section class="card" aria-labelledby="factors"><h2 id="factors">Your factors</h2>${table(['Factor', 'Kind', 'Added', 'Status', ''], view.factors.map(f => [f.label, f.kind === 'totp' ? 'Authenticator app' : 'Passkey', when(f.created_at, zone), tag(f.usable ? 'Active' : 'Needs enrolling again'), view.state ? '' : form('mfa.remove', '/app/security', hidden('factor', f.id), 'Remove', { secondary: true })]), { empty: 'No second factor yet.' })}
    <p class="hint">${view.recovery_codes_left} unused recovery codes. Removing a factor signs you out everywhere.</p></section>`
  return page('Sign-in security', actor, h`<h1>Sign-in security</h1>${held}${extra}<p id="passkey-status" role="status"></p>${confirm}${add}${factors}`, { url, current: '/app/security', status, showNav: !view.state, script: '/app/security/passkey.js' })
}

async function attempt(env: Bindings, actor: Actor, url: URL, run: () => Promise<Response>) {
  try { return await run() } catch (error) {
    const { code, status } = failure(error)
    if (status >= 500) throw error
    const target = new URL(url); target.searchParams.set('error', code)
    return await securityPage(env, actor, target, h``, status)
  }
}

export const securityPosts = {
  '/app/security/totp': (env: Bindings, actor: Actor, input: Input, url: URL) => attempt(env, actor, url, async () => {
    const started = await startTotp(env, actor, input)
    const returnTo = returnOf(input.text('returnTo', { optional: true, max: 300 }))
    return await securityPage(env, actor, url, h`<section class="card" aria-labelledby="scan"><h2 id="scan">Set up your authenticator app</h2><p>In your authenticator app, add an account with this setup key (time-based, six digits, every 30 seconds), or open the link on this device.</p><p><code class="secret" data-totp-secret>${started.secret}</code></p><p><a href="${started.uri}">Open in an authenticator app</a></p>
      <form method="post" action="/app/security/confirm" class="columns">${hidden('factor', started.factor)}${hidden('returnTo', returnTo)}${field('Code from the app', 'code')}<button type="submit">Confirm and turn on</button></form></section>`)
  }),
  '/app/security/confirm': (env: Bindings, actor: Actor, input: Input, url: URL) => attempt(env, actor, url, async () => {
    const result = await confirmTotp(env, actor, input)
    const returnTo = returnOf(input.text('returnTo', { optional: true, max: 300 }))
    return await securityPage(env, actor, url, h`<p class="flash" role="status">Your authenticator app is on.</p>${codesCard(result.recovery_codes)}<p><a class="button" href="${returnTo}">Continue</a></p>`)
  }),
  '/app/security/verify': (env: Bindings, actor: Actor, input: Input, url: URL) => attempt(env, actor, url, async () => {
    await verifyFactor(env, actor, input)
    return new Response(null, { status: 303, headers: { location: returnOf(input.text('returnTo', { optional: true, max: 300 })), 'cache-control': 'no-store' } })
  }),
}

// Runs WebAuthn in the browser and posts the result to the JSON door.
const PASSKEY_SCRIPT = `const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')
const bytes=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'==='.slice((s.length+3)%4)),c=>c.charCodeAt(0))
async function post(action,body){const r=await fetch('/api/nectar/'+action,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok)throw new Error((j.error||'failed').replace(/_/g,' '));return j}
for(const button of document.querySelectorAll('[data-passkey]'))button.addEventListener('click',async()=>{const status=document.getElementById('passkey-status');status.textContent='';button.disabled=true
try{const purpose=button.dataset.passkey,back=button.dataset.returnTo||'/app',o=await post('mfa.passkey.options',{purpose}),pk=o.publicKey
if(purpose==='register'){const c=await navigator.credentials.create({publicKey:{...pk,challenge:bytes(pk.challenge),user:{...pk.user,id:bytes(pk.user.id)},excludeCredentials:pk.excludeCredentials.map(x=>({...x,id:bytes(x.id)}))}})
const r=await post('mfa.passkey.register',{challenge_id:o.challenge_id,label:document.querySelector('[name="passkey-label"]')?.value||'Passkey',client_data_json:b64(c.response.clientDataJSON),attestation_object:b64(c.response.attestationObject)})
status.textContent='Your passkey is on.'
if(r.recovery_codes){const list=document.createElement('ol');list.className='recovery-codes';for(const code of r.recovery_codes){const li=document.createElement('li'),el=document.createElement('code');el.textContent=code;li.append(el);list.append(li)}status.append(' Recovery codes, each usable once; copy them now, they are not shown again:',list)}
const go=document.createElement('a');go.className='button';go.href=back;go.textContent='Continue';status.append(go)}
else{const c=await navigator.credentials.get({publicKey:{...pk,challenge:bytes(pk.challenge),allowCredentials:pk.allowCredentials.map(x=>({...x,id:bytes(x.id)}))}})
await post('mfa.passkey.verify',{challenge_id:o.challenge_id,credential_id:c.id,client_data_json:b64(c.response.clientDataJSON),authenticator_data:b64(c.response.authenticatorData),signature:b64(c.response.signature)});location.assign(back)}}
catch(e){status.textContent='That did not work: '+e.message}finally{button.disabled=false}})
`

export const passkeyScript = async () => new Response(PASSKEY_SCRIPT, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
