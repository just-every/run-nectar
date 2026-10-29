import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { currentNativeFixture } from './fixtures.mjs'
import { nativeClient } from './native-client.mjs'
import { errorCode } from '../../src/modules/agent-door/conformance/protocol.mjs'

let captured = false

async function person(context, path, body) {
  const response = await context.request(new URL(path, context.origin).href, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie: context.cookie, origin: context.origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error('Native agent page lifecycle failed')
  return response.json()
}

/** Browser transport reaches the disposable production Worker, with its real session. */
async function screenshots(context, pages) {
  await mkdir('.cache/agent-door-visual', { recursive: true })
  const browser = await chromium.launch({ headless: true })
  try {
    const session = await browser.newContext()
    if (context.cookie) await session.addCookies(context.cookie.split('; ').map(pair => {
      const at = pair.indexOf('=')
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: context.origin }
    }))
    await session.route(`${context.origin}/**`, async route => {
      const incoming = route.request()
      const response = await context.request(incoming.url(), { method: incoming.method(),
        headers: incoming.headers(), ...(incoming.postDataBuffer() ? { body: incoming.postDataBuffer() } : {}) })
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()) })
    })
    const page = await session.newPage()
    for (const [state, path] of pages) {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
        await page.goto(new URL(path, context.origin).href)
        const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
          controls: [...document.querySelectorAll('button:not(:disabled),input:not([type=hidden]):not(:disabled),select:not(:disabled),a.button,a.action')]
            .filter(node => node.getBoundingClientRect().width > 0).map(node => node.getBoundingClientRect().height) }))
        if (size.scroll > size.width || size.controls.some(height => height < 44)) throw new Error('Native agent screen layout failed')
        const file = `.cache/agent-door-visual/${state}-${width}.png`
        await page.screenshot({ path: file, fullPage: true })
        console.log(`Agent screen ${state} at ${width}: no overflow; controls at least 44px; ${file}`)
      }
    }
    await session.close()
  } finally { await browser.close() }
}

export async function afterStep(context) {
  if (context.step.tool === 'nectar.usage.submit') {
    const api = nativeClient(context)
    const native = (await api('audit')).find(row => row.action === 'usage.ingest' && row.subject === context.result.batch)
    const attribution = native && JSON.parse(native.detail).companyAgent
    let cursor, matched
    do {
      const audit = await person(context, `/agents/api/audit${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`)
      matched = attribution && audit.rows.find(row => row.tool === context.step.tool && row.idempotency_key === context.args.idempotency_key
        && row.operation_id === attribution.operationId && row.agent.id === attribution.agent.id
        && row.sponsor.id === attribution.sponsor.id && row.client_id === attribution.clientId
        && JSON.stringify([...(row.approval?.by ?? [])].sort()) === JSON.stringify(attribution.approvers.map(person => person.id).sort()))
      cursor = matched ? null : audit.cursor
    } while (cursor)
    if (!native || !matched || native.actor !== matched.label || context.result.accepted !== 1) {
      throw new Error('Native usage effect and door attribution disagree')
    }
  }
  if (captured || context.phase !== 'held' || context.step.id !== 'protected-answers-get') return
  const extra = await context.tool(context.step.tool, context.args)
  const pending = extra.result?._meta?.['com.runeditrun/approval']
  if (!pending?.id) throw new Error('Native browser journey requires a real held approval')
  const path = `/agents/approvals/${encodeURIComponent(pending.id)}`
  await screenshots(context, [['agents', '/agents'], ['pending', path], ['identity-settings', '/auth/settings/identity']])
  await screenshots({ ...context, cookie: '' }, [['identity-signed-out', '/auth/settings/identity']])
  const { approval } = await person(context, `/agents/api/approvals/${encodeURIComponent(pending.id)}`)
  await person(context, `/agents/api/approvals/${encodeURIComponent(pending.id)}/reject`, {
    revision: approval.revision, summary_sha256: approval.summary_sha256,
  })
  await screenshots(context, [['rejected', path], ['unavailable', '/agents/approvals/missing-native-approval']])
  await person(context, '/agents/api/pause', { paused: true })
  try { await screenshots(context, [['paused', '/agents']]) }
  finally { await person(context, '/agents/api/pause', { paused: false }) }
  captured = true
}

export default async function finish(context) {
  if (!captured) throw new Error('Native agent screens were not exercised')
  const api = nativeClient(context), fixture = currentNativeFixture()
  const narrow = await context.tool('nectar.answers.get', fixture.answer, { client: 'sender' })
  if (narrow.status !== 403) throw new Error('Native usage credential widened its scope')
  await api('credential.revoke', { key: fixture.sender })
  const before = JSON.stringify(await api('audit'))
  const refused = await context.tool('nectar.usage.submit', { ...fixture.localUsage, idempotency_key: randomUUID() }, { client: 'sender' })
  if (refused.status !== 401 || before !== JSON.stringify(await api('audit'))) throw new Error('Revoked native credential made an effect')
  console.log('Native local credential: scoped usage call, read-scope refusal and next-effect revocation proved.')
  const stale = await context.tool('nectar.controls.record', { ...fixture.control,
    expected_revision: 'stale-native-revision', idempotency_key: randomUUID() })
  if (errorCode(stale) !== 'revision_conflict' || before !== JSON.stringify(await api('audit'))) {
    throw new Error('Stale native control revision made an effect')
  }
  await person(context, '/agents/api/pause', { paused: true })
  try {
    const paused = await context.tool('nectar.usage.submit', { ...fixture.localUsage, idempotency_key: randomUUID() })
    if (errorCode(paused) !== 'agents_paused' || before !== JSON.stringify(await api('audit'))) {
      throw new Error('Local Pause allowed a native effect')
    }
  } finally { await person(context, '/agents/api/pause', { paused: false }) }
  console.log('Native revision conflict and local Pause: refused with unchanged native activity.')
}
