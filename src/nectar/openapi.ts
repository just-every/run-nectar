// DEV-002: the OpenAPI 3.1 document for /api/nectar, built from the same
// registries the doors dispatch through (actions.ts, doors.ts) and the body
// fields each action's handler reads (api-fields.ts, generated from source).
import { actions } from './actions'
import { API_FIELDS, type FieldKind } from './api-fields'
import { CHANGES, LATEST_VERSION, VERSIONS } from './api-versions'
import { API_DOORS, LIST_DOORS } from './doors'

const SCHEMAS: Record<FieldKind, Record<string, unknown>> = {
  text: { type: 'string' },
  integer: { type: ['integer', 'string'], description: 'A whole number, or its decimal string.' },
  list: { type: 'array', items: { type: 'string' } },
  json: { description: 'A structured JSON value.' },
  flag: { type: ['boolean', 'string'], description: 'true, or "yes"/"on"/"true".' },
  file: { type: 'object', properties: { filename: { type: 'string' }, base64: { type: 'string' }, type: { type: 'string' } }, required: ['filename', 'base64'] },
  has: { description: 'Any JSON value; read by presence or by a rule named at run time.' },
}

const operationId = (name: string, prefix = '') => prefix + name.split(/[^A-Za-z0-9]+/).filter(Boolean).map((part, index) => index || prefix ? part[0].toUpperCase() + part.slice(1) : part).join('')

const header = (name: string, description: string, schema: Record<string, unknown>) => ({ name, in: 'header', required: false, description, schema })
const versionHeader = header('Nectar-Version', 'Answer this call under this dated version instead of the credential\'s pinned one (members: the latest).', { type: 'string', enum: VERSIONS })
const responses = {
  200: { description: 'The result, shaped by the request\'s API version (also returned in the Nectar-Version response header).', content: { 'application/json': { schema: {} } } },
  default: { description: 'A refusal or error.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
}

/** `^invoices/([\w-]+/lines/[\w-]+)$` becomes `/api/nectar/invoices/{id1}/lines/{id2}`. */
function door(pattern: string) {
  const params: string[] = []
  const body = pattern.replace(/^\^|\$$/g, '').replace(/\(([^)]*)\)/g, (_, group: string) => group.split('/').map(segment => {
    if (!/[[\]+*]/.test(segment)) return segment
    params.push(`id${params.length + 1}`)
    return `{${params[params.length - 1]}}`
  }).join('/')).replace(/\\\./g, '.')
  const names = params.length === 1 ? ['id'] : params
  let index = 0
  return { path: `/api/nectar/${body.replace(/\{id\d+\}/g, () => `{${names[index++]}}`)}`, params: names }
}

export function openApiDocument(origin: string) {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const [pattern, name] of API_DOORS) {
    const { path, params } = door(pattern)
    const query = LIST_DOORS.includes(name) || name === 'invoices'
      ? [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 100 } }, { name: 'cursor', in: 'query', required: false, description: 'The previous page\'s next_cursor; it binds the page size.', schema: { type: 'string' } }]
      : []
    paths[path] = { get: { operationId: operationId(name, 'get'), parameters: [...params.map(p => ({ name: p, in: 'path', required: true, schema: { type: 'string' } })), ...query, versionHeader], responses } }
  }
  for (const name of Object.keys(actions).sort()) {
    const fields = API_FIELDS[name] ?? {}
    const properties = Object.fromEntries(Object.entries(fields).filter(([field]) => field !== '*').map(([field, kind]) => [field, SCHEMAS[kind]]))
    paths[`/api/nectar/${name}`] = { post: {
      operationId: operationId(name), parameters: [header('Idempotency-Key', 'Up to 255 printable characters. Repeating a write with the same key and identical request within 24 hours returns the first successful result without a second record; a different request under the key is refused (409).', { type: 'string', maxLength: 255 }), versionHeader],
      requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties, additionalProperties: '*' in fields } } } },
      responses,
    } }
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Nectar API', version: LATEST_VERSION, description: 'Dated versions, oldest first: ' + VERSIONS.join(', ') + '. Changes: ' + CHANGES.map(change => `${change.version}: ${change.summary}`).join(' ') },
    servers: [{ url: origin }],
    security: [{ credential: [] }, { session: [] }],
    components: {
      securitySchemes: { credential: { type: 'http', scheme: 'bearer', description: 'An application credential issued on Access.' }, session: { type: 'apiKey', in: 'cookie', name: 'session', description: 'A signed-in member\'s session; writes need this origin\'s Origin header.' } },
      schemas: { Error: { type: 'object', properties: { error: { type: 'string' }, detail: {} }, required: ['error'] } },
    },
    paths,
  }
}
