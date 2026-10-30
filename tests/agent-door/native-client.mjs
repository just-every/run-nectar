/** Fixture traffic uses only the conformance runner's supplied native HTTP client. */
export function nativeClient({ request, origin, cookie }) {
  return async function api(action, body) {
    const headers = { accept: 'application/json', origin }
    if (cookie) headers.cookie = cookie
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await request(new URL(`/api/nectar/${action}`, origin).href, {
      method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const result = await response.json()
    if (!response.ok) {
      // Do not include response bodies, cookies or credentials in fixture errors.
      const code = typeof result?.error === 'string' ? result.error : 'native_request_failed'
      throw new Error(`Nectar fixture ${action.split('?')[0]}: ${response.status} ${code}`)
    }
    return result
  }
}
