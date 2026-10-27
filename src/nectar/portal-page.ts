import { thresholdPortalStyle } from './portal-threshold-style'
// Customer pages have their own frame: no operator navigation, product mark,
// scripts or third-party assets on a merchant's branded domain.
import { h, type Html } from './ui/html'

export const portalHeaders = {
  'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow',
}

export function portalPage(title: string, body: Html, { lang = 'en', name = '', style = '/portal/theme.css', status = 200 } = {}) {
  const document = h`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}${name ? ` · ${name}` : ''}</title><link rel="stylesheet" href="${style}"></head><body><main>${name ? h`<p class="merchant">${name}</p>` : ''}${body}</main></body></html>`
  return new Response(document.html, { status, headers: { ...portalHeaders, 'content-type': 'text/html; charset=utf-8' } })
}

export function portalStyle(color = '#245c46') {
  // Validate again at the output boundary, including restored database values.
  const accent = /^#[0-9a-f]{6}$/i.test(color) ? color : '#245c46'
  return new Response(`:root{font-family:system-ui,sans-serif;color:#202923;background:#f5f7f4;line-height:1.5;--accent:${accent}}*{box-sizing:border-box}body{margin:0}main{max-width:960px;margin:auto;padding:32px 24px;overflow-wrap:anywhere}.merchant{font-size:1.15rem;font-weight:750;border-top:5px solid var(--accent);padding-top:20px}h1{font-size:clamp(1.65rem,5vw,2.4rem);line-height:1.2}h2{font-size:1.25rem}h3{font-size:1.1rem}.card{background:white;border:1px solid #dbe2db;border-radius:12px;padding:24px;margin:24px 0}dl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px 24px}dt{color:#536056}dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}a{color:var(--accent);text-underline-offset:4px;display:inline-flex;align-items:center;min-height:44px}button{min-height:44px;font:inherit}input,select,textarea{max-width:100%;font:inherit}${thresholdPortalStyle}@media(max-width:500px){main{padding:20px 16px}.card{padding:18px}dl{gap:12px}}`, { headers: { ...portalHeaders, 'content-type': 'text/css; charset=utf-8' } })
}
