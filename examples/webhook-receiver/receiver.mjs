// A receiving app for Nectar webhooks (DEV-001). It verifies every delivery's
// Nectar-Signature against the signing secrets it holds (two while a rotation
// overlaps), refuses forged, altered or stale deliveries with 400, and handles
// each event id once however many times it is delivered or replayed.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

/** True when `header` carries a v1 signature of "t.body" by one of `secrets` and t is within `toleranceSeconds` of `now`. */
export function verifyNectarSignature(header, body, secrets, { now = Date.now(), toleranceSeconds = 300 } = {}) {
  const parts = String(header ?? '').split(',').map(part => part.split('='))
  const t = parts.find(([key]) => key === 't')?.[1]
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value)
  if (!t || !/^\d+$/.test(t) || !signatures.length || Math.abs(now / 1000 - Number(t)) > toleranceSeconds) return false
  return secrets.some(secret => {
    const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest()
    return signatures.some(signature => /^[0-9a-f]{64}$/.test(signature) && timingSafeEqual(expected, Buffer.from(signature, 'hex')))
  })
}

/** Starts the receiver on 127.0.0.1. `secrets` may be changed while it runs; `handled` lists each event once. */
export async function startReceiver({ secrets = [], port = 0, path = '/webhooks/nectar', onEvent = () => {} } = {}) {
  const state = { secrets, handled: [], seen: new Set(), deliveries: [], refused: 0, down: false }
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      if (state.down) { response.writeHead(503).end(); return }
      if (request.method !== 'POST' || new URL(request.url, 'http://receiver').pathname !== path) { response.writeHead(404).end(); return }
      const body = Buffer.concat(chunks).toString('utf8')
      if (!verifyNectarSignature(request.headers['nectar-signature'], body, state.secrets)) { state.refused += 1; response.writeHead(400).end('invalid signature'); return }
      const event = JSON.parse(body)
      state.deliveries.push({ id: request.headers['nectar-delivery-id'], event: event.id, body, signatures: String(request.headers['nectar-signature']).split(',').filter(part => part.startsWith('v1=')).length })
      if (!state.seen.has(event.id)) { state.seen.add(event.id); state.handled.push(event); onEvent(event) }
      response.writeHead(204).end()
    })
  })
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  return { state, url: `http://127.0.0.1:${server.address().port}${path}`, close: () => new Promise(resolve => server.close(resolve)) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const secrets = (process.env.NECTAR_WEBHOOK_SECRETS ?? '').split(',').map(secret => secret.trim()).filter(Boolean)
  if (!secrets.length) { console.error('Set NECTAR_WEBHOOK_SECRETS to the endpoint signing secret (comma-separated during a rotation).'); process.exit(64) }
  const receiver = await startReceiver({ secrets, port: Number(process.env.PORT ?? 4242), onEvent: event => console.log(`${event.type} ${event.id}`) })
  console.log(`Receiving Nectar webhooks at ${receiver.url}`)
}
