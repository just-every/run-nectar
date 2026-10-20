// Run the single-customer local sample with an owner-issued embedded-session
// JSON response in a private file. No credentials are accepted in arguments.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { portalApp } from './app.mjs'

const file = process.env.PORTAL_SESSION_FILE
if (!file || ((await stat(file)).mode & 0o077)) throw new Error('PORTAL_SESSION_FILE must name a mode-0600 session JSON file')
const session = JSON.parse(await readFile(file, 'utf8'))
const app = portalApp({ portalOrigin:new URL(session.url).origin, sessionForRequest:async () => JSON.parse(await readFile(file,'utf8')) })
const port = Number(process.env.PORT || 3000)
const server = createServer(async (incoming,outgoing) => {
  try {
    const response = await app(new Request(`http://127.0.0.1:${port}${incoming.url}`, { method:incoming.method }))
    outgoing.writeHead(response.status,Object.fromEntries(response.headers))
    outgoing.end(Buffer.from(await response.arrayBuffer()))
  } catch { outgoing.writeHead(500);outgoing.end('Unable to open billing. Check the private session file.') }
})
server.listen(port,'127.0.0.1',() => console.log(`Sample app: http://127.0.0.1:${port}/billing`))
