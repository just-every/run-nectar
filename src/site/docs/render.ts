// One docs Markdown page to static HTML at build time. Raw HTML in the Markdown
// is shown as text; headings get GitHub-style ids; code blocks become the ink
// code card labelled with their language; tables scroll inside their own box.
// A page with a level-1 heading, an image, a code block without a language or a
// link to a docs page that does not exist fails the build.
import { Marked } from 'marked'

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!))
const LANGUAGES: Record<string, string> = { sh: 'Shell', json: 'JSON', text: 'Text', csv: 'CSV' }
// Remove until nothing matches, so a removal cannot join its neighbours into a new match ("<<b>script>").
function removeAll(text: string, pattern: RegExp): string {
  let previous: string
  do { previous = text; text = text.replace(pattern, '') } while (text !== previous)
  return text
}
const stripTags = (html: string) => removeAll(html, /<[^>]+>/g)
const slugify = (text: string) => removeAll(stripTags(text.toLowerCase()), /&[a-z#0-9]+;/g).replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-')

export interface Rendered { html: string; contents: { id: string; text: string }[] }

export function renderMarkdown(markdown: string, file: string, slugs: Set<string>): Rendered {
  const contents: Rendered['contents'] = []
  const problems: string[] = []
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        if (depth === 1) problems.push('has a level-1 heading; the title comes from docs/site.json')
        const inner = this.parser.parseInline(tokens), id = slugify(inner)
        if (depth === 2) contents.push({ id, text: stripTags(inner) })
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`
      },
      code({ text, lang }) {
        const language = (lang ?? '').trim().split(/\s+/)[0].toLowerCase()
        if (!LANGUAGES[language]) problems.push(`has a code block in "${language}"; name one of ${Object.keys(LANGUAGES).join(', ')}`)
        return `<div class="docs-code"><p class="docs-code-lang">${LANGUAGES[language] ?? 'Code'}</p><pre><code>${escape(text.replace(/\n$/, ''))}</code></pre></div>\n`
      },
      html({ text }) { return escape(text) },
      image({ href }) { problems.push(`has an image (${href}); the docs publish text only`); return '' },
      link({ href, tokens }) {
        const docs = /^\/docs(?:\/([a-z0-9-]+))?(?:#.*)?$/.exec(href)
        if (href.startsWith('/') && (!docs || (docs[1] && !slugs.has(docs[1])))) problems.push(`links to ${href}, which is not a docs page`)
        return `<a href="${escape(href)}">${this.parser.parseInline(tokens)}</a>`
      },
      table(token) {
        const head = token.header.map(cell => `<th scope="col">${this.parser.parseInline(cell.tokens)}</th>`).join('')
        const rows = token.rows.map(row => `<tr>${row.map(cell => `<td>${this.parser.parseInline(cell.tokens)}</td>`).join('')}</tr>`).join('')
        return `<div class="docs-table"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`
      },
    },
  })
  const html = marked.parse(markdown, { async: false })
  if (problems.length) throw new Error(`docs/${file} ${problems.join('; ')}`)
  return { html, contents }
}
