// A real, deliberately small merchant app. The trusted backend callback must
// authenticate its visitor and obtain a Nectar session for that customer.
// Only the resulting customer capability reaches the iframe; no signing key
// or operator credential belongs in this page.
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]))

export function portalApp({ portalOrigin, sessionForRequest, name = 'Fieldnote' }) {
  const portal = new URL(portalOrigin)
  if (portal.origin !== portalOrigin || !['http:','https:'].includes(portal.protocol)) throw new Error('Use an exact portal origin')
  return async request => {
    const url = new URL(request.url)
    const headers = { 'cache-control':'no-store', 'referrer-policy':'no-referrer', 'x-content-type-options':'nosniff', 'content-security-policy':`default-src 'none'; style-src 'self'; frame-src ${portalOrigin}; frame-ancestors 'none'; base-uri 'none'` }
    if (request.method !== 'GET') return new Response(null, { status:405,headers:{ ...headers,allow:'GET' } })
    if (url.pathname === '/sample.css') return new Response('body{margin:0;font:16px system-ui;background:#f5f7f4;color:#202923}header{padding:20px 24px;border-bottom:1px solid #dbe2db}h1{font-size:1.2rem;margin:0}iframe{display:block;border:0;width:100%;height:calc(100vh - 66px);min-height:700px}', { headers:{ ...headers,'content-type':'text/css' } })
    if (url.pathname !== '/billing') return new Response('Not found', { status:404,headers })
    const session = await sessionForRequest(request)
    if (!session) return new Response('Sign in to your merchant account first.', { status:401,headers })
    const target = new URL(session.url)
    if (target.origin !== portalOrigin || target.pathname !== '/portal' || target.searchParams.getAll('session').length !== 1) throw new Error('Unexpected Nectar customer session URL')
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Billing · ${escape(name)}</title><link rel="stylesheet" href="/sample.css"></head><body><header><h1>${escape(name)} account</h1></header><iframe title="Customer billing" src="${escape(target.href)}" sandbox="allow-same-origin allow-forms"></iframe></body></html>`, { headers:{ ...headers,'content-type':'text/html; charset=utf-8' } })
  }
}
