import { createServer, request } from 'node:http'

// Keep the public origin bound while Miniflare starts and reloads on its own
// ephemeral ports. Forward HTTP unchanged, including Host and Set-Cookie.
export async function httpListener(ready, hostname) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const target = new URL(incoming.url, await ready())
      const upstream = request(target, { method: incoming.method, headers: incoming.headers, agent: false }, response => {
        outgoing.writeHead(response.statusCode, response.headers)
        response.on('error', error => outgoing.destroy(error))
        response.pipe(outgoing)
      })
      upstream.on('error', error => outgoing.destroy(error))
      incoming.on('error', error => upstream.destroy(error))
      incoming.on('aborted', () => upstream.destroy())
      incoming.pipe(upstream)
    } catch (error) { outgoing.destroy(error) }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    origin: `http://${hostname}:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}
