// The run site's shared frame: the document head, the header (mark + Nectar,
// Docs, Source) and the one-line footer. The homepage and every docs page use
// it; /run and /404 are Base's pages, themed by the same tokens.
import type { RunData } from '../base/run-site'

export const esc = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!))

/** Nectar's mark: one flat-top honey hexagon with a lighter facet (public/brand/mark.svg). */
export const mark = (size: number) => `<img class="mark" src="/brand/mark.svg" alt="" width="${size}" height="${size}">`

export function siteDocument({ title, description, styles, body }: { title: string; description: string; styles: string[]; body: string }): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><meta name="theme-color" content="#FFFCF5">`
    + '<link rel="icon" type="image/svg+xml" href="/brand/mark.svg">'
    + '<link rel="preload" href="/fonts/hanken-grotesk/hanken-grotesk-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin="anonymous">'
    + '<link rel="stylesheet" href="/fonts/fonts.css"><link rel="stylesheet" href="/rer-theme.css">'
    + styles.map(href => `<link rel="stylesheet" href="${esc(href)}">`).join('')
    + `</head><body>${body}</body></html>`
}

export function siteHeader(run: RunData, current: 'home' | 'docs' = 'home'): string {
  return `<header class="site-bar"><a class="site-brand" href="/">${mark(26)}<span>${esc(run.name)}</span></a>`
    + `<nav aria-label="Site"><a href="/docs"${current === 'docs' ? ' aria-current="page"' : ''}>Docs</a><a href="${esc(run.repository)}">Source</a></nav></header>`
}

export function siteFooter(run: RunData): string {
  return `<footer class="site-foot"><a class="site-brand" href="/">${mark(20)}<span>${esc(run.name)}</span></a>`
    + `<nav aria-label="Footer"><a href="${esc(run.repository)}/blob/main/LICENSE">${esc(run.licence)} licensed</a><a href="/docs">Docs</a><a href="${esc(run.repository)}">Source</a></nav></footer>`
}
