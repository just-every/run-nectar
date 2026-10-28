/// <reference types="vite/client" />
// The published docs: docs/site.json names the sections and pages, and each
// page's Markdown in docs/ is rendered once, at build time.
import site from '../../../docs/site.json'
import { renderMarkdown, type Rendered } from './render'

export interface DocsPage { slug: string; title: string; file: string; summary: string }
export interface DocsSection { title: string; pages: DocsPage[] }

const files = import.meta.glob(['../../../docs/*.md', '!../../../docs/CLAIMS.md'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

export const docsSections: DocsSection[] = site.sections
export const docsPages: DocsPage[] = docsSections.flatMap(section => section.pages)
export const docsLead = 'Run Nectar, bill your first month and keep your data: the guides for the owner and the finance team.'

const slugs = new Set(docsPages.map(page => page.slug))

/** Every page with its rendered body; a missing file, or one no page names, fails the build. */
export function renderedPages(): (DocsPage & Rendered)[] {
  const named = new Set(docsPages.map(page => page.file))
  const unnamed = Object.keys(files).map(path => path.split('/').pop()!).filter(file => !named.has(file))
  if (unnamed.length) throw new Error(`docs/site.json does not name ${unnamed.join(', ')}`)
  return docsPages.map(page => {
    const markdown = files[`../../../docs/${page.file}`]
    if (markdown === undefined) throw new Error(`docs/site.json names ${page.file}, which is not in docs/`)
    return { ...page, ...renderMarkdown(markdown, page.file, slugs) }
  })
}

export function neighbours(slug: string) {
  const index = docsPages.findIndex(page => page.slug === slug)
  return { previous: docsPages[index - 1], next: docsPages[index + 1] }
}
