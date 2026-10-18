// The homepage's small pieces, each drawn the same way in every section: the
// stage-and-date eyebrow, the two-line heading with the gradient second line,
// round icon tiles, state pills, collaborator cursors, sticky notes, spark
// doodles and dashed connectors. Positions live in the section stylesheets.
import { esc } from '../shell'
import { ARROW_CURSOR, SPARK, icon, type IconName } from './icons'

export const ARROW = '<svg class="arw" viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 10h12M10.5 4.5 16 10l-5.5 5.5"/></svg>'
export const TICK = icon('check', 'tick')

export const eyebrow = (text: string) => `<p class="eyebrow">${esc(text)}</p>`

/** The section heading: the first line in ink, the second in the coral-to-tangerine gradient. */
export const heading = (id: string, first: string, second: string, tag = 'h2') =>
  `<${tag} id="${id}" class="heading"><span class="l1">${first}</span> <span class="l2">${second}</span></${tag}>`

export type Tone = 'coral' | 'blue' | 'yellow' | 'pink' | 'mint' | 'grey' | 'red' | 'green'
/** A round icon tile; `coral` is the solid gradient tile, the others are soft tints. */
export const tile = (name: IconName, tone: Tone, className = '') => `<span class="tile ${tone}${className ? ` ${className}` : ''}" aria-hidden="true">${icon(name)}</span>`

export type PillTone = 'paid' | 'failed' | 'pending' | 'peach'
export const pill = (html: string, tone: PillTone = 'paid', tick = tone === 'paid', className = '') =>
  `<span class="pill ${tone}${className ? ` ${className}` : ''}">${html}${tick ? TICK : ''}</span>`

export type Person = 'dana' | 'marcus' | 'leo'
const NAMES: Record<Person, string> = { dana: 'Dana', marcus: 'Marcus', leo: 'Leo' }
/** A collaborator cursor: the arrow and its name tag, in that person's colour. */
export const cursor = (who: Person, className: string) => `<span class="cursor ${who} ${className}" aria-hidden="true">${ARROW_CURSOR}<b>${NAMES[who]}</b></span>`

/** A pale-yellow sticky note in the hand face; `lines` break where the desk breaks them. */
export const sticky = (lines: string[], className: string, underline = false) =>
  `<p class="sticky ${className}">${lines.map(esc).join('<br>')}${underline ? '<svg class="scribble" viewBox="0 0 100 12" aria-hidden="true"><path d="M3 9c22-5 58-8 94-6"/></svg>' : ''}</p>`

export const spark = (className: string) => `<span class="spark ${className}" aria-hidden="true">${SPARK}</span>`

/** A dashed connector drawn in the board's own units (one unit is one desk pixel). */
export const connector = (className: string, viewBox: string, d: string, arrow = false) =>
  `<svg class="connector ${className}" viewBox="${viewBox}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"${arrow ? ' marker-end="url(#nc-arrowhead)"' : ''}/></svg>`

/** The arrowhead the connectors share, defined once per page. */
export const connectorDefs = '<svg class="defs" width="0" height="0" aria-hidden="true"><defs><marker id="nc-arrowhead" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1.5 7 5 1 8.5" fill="none" stroke="#7d8492" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker></defs></svg>'

/** One row of label and figure. */
export const row = (label: string, value: string, className = 'row') => `<p class="${className}"><span>${label}</span><span class="fig">${value}</span></p>`

/** A section of the story: the board holds the copy and the drawings at the desk's positions on wide screens and stacks them below. */
export const story = (id: string, className: string, inner: string) => `<section class="story ${className}" id="${id}" aria-labelledby="${id}-title"><div class="board">${inner}</div></section>`
