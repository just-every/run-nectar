// The docs pages in the landing's look: the site header with Docs current, the
// page list beside the article, a faint honey glow behind the title, and the
// previous and next pages at the foot.
import type { RunData } from '../../base/run-site'
import { esc, siteFooter, siteHeader } from '../shell'
import { docsLead, docsSections, neighbours, type DocsPage } from './pages'
import type { Rendered } from './render'

function nav(current?: string): string {
  return `<nav class="docs-nav" aria-label="Docs"><a class="docs-home${current ? '' : ' current'}" href="/docs"${current ? '' : ' aria-current="page"'}>All guides</a>`
    + docsSections.map(section => `<p class="docs-nav-title">${esc(section.title)}</p><ul>${section.pages.map(page => `<li><a href="/docs/${page.slug}"${page.slug === current ? ' aria-current="page"' : ''}>${esc(page.title)}</a></li>`).join('')}</ul>`).join('')
    + '<p class="docs-nav-title">Project</p><ul><li><a href="/contract">Contract</a></li></ul></nav>'
}

const hexagon = '<span class="docs-hex" aria-hidden="true"><svg viewBox="0 0 34 38"><path d="M17 1.5 32 10.2v17.6L17 36.5 2 27.8V10.2Z" fill="#F6B23E" stroke="#F6B23E" stroke-width="2" stroke-linejoin="round"/></svg></span>'

export function docsIndexBody(run: RunData): string {
  const sections = docsSections.map(section => `<section class="docs-group" aria-labelledby="g-${section.pages[0].slug}"><h2 id="g-${section.pages[0].slug}">${esc(section.title)}</h2><ul class="docs-cards">`
    + section.pages.map(page => `<li><a href="/docs/${page.slug}">${hexagon}<span><b>${esc(page.title)}</b><span>${esc(page.summary)}</span></span></a></li>`).join('') + '</ul></section>').join('')
  return `${siteHeader(run, 'docs')}<main class="docs"><div class="docs-layout">${nav()}<div class="docs-main"><header class="docs-head"><h1>Docs</h1><p class="docs-lead">${esc(docsLead)}</p></header>${sections}</div></div></main>${siteFooter(run)}`
}

export function docsPageBody(run: RunData, page: DocsPage & Rendered): string {
  const { previous, next } = neighbours(page.slug)
  const pager = `<nav class="docs-pager" aria-label="Previous and next">${previous ? `<a class="prev" href="/docs/${previous.slug}"><span>Previous</span><b>${esc(previous.title)}</b></a>` : '<span></span>'}${next ? `<a class="next" href="/docs/${next.slug}"><span>Next</span><b>${esc(next.title)}</b></a>` : ''}</nav>`
  return `${siteHeader(run, 'docs')}<main class="docs"><div class="docs-layout">${nav(page.slug)}<article class="docs-main"><header class="docs-head"><p class="docs-crumb"><a href="/docs">Docs</a></p><h1>${esc(page.title)}</h1><p class="docs-lead">${esc(page.summary)}</p></header>`
    + `<div class="prose">${page.html}</div>${pager}</article></div></main>${siteFooter(run)}`
}
