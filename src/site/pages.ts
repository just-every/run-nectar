// The run site `rer build --site` writes (run-nectar.com): the landing at /,
// whose Run Nectar opens Base's Run page at /run; the docs at /docs and
// /docs/<slug>, rendered from the Markdown in docs/; and the not-found page.
// Every Run page string and command is in run.json; nothing here reads
// installation data.
import { contractPageHtml } from '../base/contract-page'
import { runPageHtml, siteNotFoundHtml, type RunData, type SiteBuild, type SiteContext } from '../base/run-site'
import { identity } from '../identity'
import './site.css'
import './docs/docs.css'
import { docsIndexBody, docsPageBody } from './docs/layout'
import { docsLead, renderedPages } from './docs/pages'
import { copy } from './homepage/copy'
import { landing } from './homepage/landing'
import run from './run.json'
import { siteDocument, siteFooter, siteHeader } from './shell'

export function sitePages({ styles, contract }: SiteContext): SiteBuild {
  const data: RunData = run
  const docs = renderedPages().map(page => ({ path: `/docs/${page.slug}`, html: siteDocument({ title: `${page.title} · Nectar docs`, description: page.summary, styles, body: docsPageBody(data, page) }) }))
  return {
    pages: [
      { path: '/', html: siteDocument({ title: copy.title, description: copy.description, styles, body: landing(siteHeader(data), siteFooter(data)) }) },
      { path: '/run', html: runPageHtml(identity, data, contract) },
      ...(contract ? [{ path: '/contract', html: contractPageHtml(identity, data, contract) }] : []),
      { path: '/docs', html: siteDocument({ title: 'Docs · Nectar', description: docsLead, styles, body: docsIndexBody(data) }) },
      ...docs,
      { path: '/404', html: siteNotFoundHtml(identity, data, contract) },
    ],
    assets: ['rer-theme.css', 'fonts', 'brand', 'site', 'favicon.ico'],
  }
}
