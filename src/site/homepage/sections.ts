// The landing, top to bottom: hero, five alternating sections, Also included,
// the closing band. Pure server HTML; the run site ships no script.
import { esc } from '../shell'
import { copy } from './copy'
import { chargesCard, heroFlow, included, licenceCard, monthCard, owedCard, shadowCard } from './drawings'

const ARROW = '<span aria-hidden="true">→</span>'
const actions = () => `<div class="actions"><a class="run" href="/run">${esc(copy.run)} ${ARROW}</a><a class="docs-link" href="/docs">${esc(copy.docs)}</a></div>`

export function hero(): string {
  const [first, second, third] = copy.rivals.map(name => `<strong>${esc(name)}</strong>`)
  return `<section class="hero" id="top" aria-labelledby="hero-title"><h1 id="hero-title">${esc(copy.headline)}</h1><p class="subhead">${esc(copy.subhead)}</p>`
    + `<p class="alternative">100% free, open source alternative to ${first}, ${second} and ${third}</p>${actions()}<p class="small">${esc(copy.small)}</p>`
    + `<div class="art hero-art">${heroFlow()}</div></section>`
}

// Drawing left on the first, third and fifth sections; right on the others.
const section = (id: string, text: { title: string; body: string }, drawing: string, index: number) =>
  `<section class="feature${index % 2 ? ' flip' : ''}" id="${id}" aria-labelledby="${id}-title"><div class="art">${drawing}</div>`
  + `<div class="text"><h2 id="${id}-title">${esc(text.title)}</h2><p>${esc(text.body)}</p></div></section>`

export function sections(): string {
  const { free, explain, month, stripe, owed } = copy.sections
  return [
    section('free', free, licenceCard(), 0),
    section('explain', explain, chargesCard(), 1),
    section('month', month, monthCard(), 2),
    section('stripe', stripe, shadowCard(), 3),
    section('owed', owed, owedCard(), 4),
  ].join('')
    + `<section class="included" id="included" aria-labelledby="included-title"><h2 id="included-title">${esc(copy.included.title)}</h2>${included([...copy.included.items])}</section>`
}

export const closing = () => `<section class="closing" aria-labelledby="closing-title"><h2 id="closing-title">${esc(copy.headline)}</h2>${actions()}</section>`

export const landing = (header: string, footer: string) => `${header}<main class="landing">${hero()}${sections()}${closing()}</main>${footer}`
