// The run site's shared frame: the document head (favicons, share image), the
// header (mark + Nectar, Docs, Contract, Source) and the footer set in type.
// The homepage and every docs page use it; /run and /404 are Base's pages,
// themed by the same tokens.
import type { RunData } from '../base/run-site'
import { identity } from '../identity'
import { copy } from './homepage/copy'

export const esc = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!))

/** Nectar's mark: the smiling two-tone nectarine (public/brand/mark.svg). */
export const mark = (size: number) => `<img class="mark" src="/brand/mark.svg" alt="" width="${size}" height="${size}">`

export function siteDocument({ title, description, styles, body }: { title: string; description: string; styles: string[]; body: string }): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${esc(title)}</title><meta name="description" content="${esc(description)}"><meta name="theme-color" content="#ffffff">`
    + '<link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" type="image/svg+xml" href="/brand/favicon-32.svg"><link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">'
    + `<meta property="og:type" content="website"><meta property="og:site_name" content="Nectar"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}">`
    + `<meta property="og:image" content="${identity.runSite}/site/share.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image">`
    + '<link rel="preload" href="/fonts/hanken-grotesk/hanken-grotesk-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin="anonymous">'
    + '<link rel="stylesheet" href="/fonts/fonts.css"><link rel="stylesheet" href="/rer-theme.css">'
    + styles.map(href => `<link rel="stylesheet" href="${esc(href)}">`).join('')
    + `</head><body>${body}</body></html>`
}

export function siteHeader(run: RunData, current: 'home' | 'docs' = 'home'): string {
  return `<header class="site-bar"><a class="site-brand" href="/">${mark(56)}<span>${esc(run.name)}</span></a>`
    + `<nav aria-label="Site"><a href="/docs"${current === 'docs' ? ' aria-current="page"' : ''}>Docs</a><a href="/contract">Contract</a><a href="${esc(run.repository)}">Source</a></nav></header>`
}

export function siteFooter(run: RunData): string {
  return `<footer class="site-foot"><p class="site-sign"><a class="site-brand" href="/">${mark(36)}<span>${esc(run.name)}</span></a><span class="site-tag">${esc(copy.footer)}</span></p>`
    + `<nav aria-label="Footer"><a href="/docs">Docs</a><a href="${esc(run.repository)}">Source</a><a href="${esc(run.repository)}/blob/main/LICENSE">${esc(run.licence)} licensed</a></nav></footer>`
}
