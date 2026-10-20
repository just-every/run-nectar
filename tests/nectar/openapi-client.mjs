// A generic client generated at run time from an OpenAPI 3.1 document: one
// method per operationId, path and query parameters from the document, a JSON
// body, and the document's own header parameters passed by name.
export function generateClient(document, { fetch: send = fetch, headers = {} } = {}) {
  const base = document.servers[0].url
  const client = {}
  for (const [template, operations] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      const parameters = operation.parameters ?? []
      client[operation.operationId] = async (args = {}) => {
        let path = template
        const query = new URLSearchParams(), extra = {}
        for (const parameter of parameters) {
          const value = args[parameter.name]
          if (value === undefined) {
            if (parameter.required) throw new Error(`${operation.operationId} needs ${parameter.name}`)
            continue
          }
          if (parameter.in === 'path') path = path.replace(`{${parameter.name}}`, encodeURIComponent(value))
          else if (parameter.in === 'query') query.set(parameter.name, String(value))
          else if (parameter.in === 'header') extra[parameter.name] = String(value)
        }
        const body = method === 'post' ? JSON.stringify(args.body ?? {}) : undefined
        const response = await send(`${base}${path}${query.size ? `?${query}` : ''}`, {
          method: method.toUpperCase(), redirect: 'manual', body,
          headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
        })
        const text = await response.text()
        return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null }
      }
    }
  }
  return client
}
