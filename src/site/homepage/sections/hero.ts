// 01 Hero: the approved hero, its copy and its six cards rebuilt in HTML over
// a cutout of the painted peach (the only painted art up here), the dashed
// ring, sparks, Dana's and Marcus's cursors and the "Oct 1 — all sent!" sticky.
import '../styles/hero.css'
import { esc } from '../../shell'
import { copy } from '../copy'
import { ARROW, cursor, pill, spark, sticky, tile } from '../parts'
import { lakeview, mesa, pinecrest, run } from '../records'

const art = (name: string, widths: number[], width: number, height: number, alt: string, className: string, sizes: string) => {
  const set = (type: string) => widths.map(w => `/site/${name}-${w}.${type} ${w}w`).join(', ')
  return `<picture class="${className}"><source type="image/avif" srcset="${set('avif')}" sizes="${sizes}"><source type="image/webp" srcset="${set('webp')}" sizes="${sizes}">`
    + `<img src="/site/${name}-${widths[widths.length - 1]}.webp" width="${width}" height="${height}" alt="${esc(alt)}" decoding="async"${className.includes('lazy') ? ' loading="lazy"' : ''}></picture>`
}
export { art }

const cards = [
  `<article class="hc h-run at">${tile('invoice', 'coral')}<div><h3>October bill run</h3><p class="sub">${run.invoices} invoices</p><p class="amt fig">${run.total}</p><p class="small">issued 6:00 am</p></div>`
    + `<p class="meter"><span class="track"><span class="fill green"></span></span><span class="pct">100%</span></p>${spark('sp-run')}</article>`,
  `<article class="hc h-lake at">${tile('building', 'blue')}<div><h3>Lakeview Freight</h3><p class="sub">${lakeview.seats} seats</p><p class="sub">1.2M API calls</p><p class="amt fig">${lakeview.total}</p>`
    + `<p class="foot">${pill('Paid by card')}<span class="small">Thu Oct 1</span></p></div></article>`,
  `<article class="hc h-mesa at">${tile('sun', 'yellow')}<div><h3>Mesa Solar</h3><p class="was">${pill('<s>Card declined</s>', 'failed', false)}<span class="arw" aria-hidden="true">→</span></p><p class="small">Retried ${mesa.retried}</p></div>`
    + `<p class="paid">${pill(`${mesa.amount} paid`)}</p>${cursor('dana', 'cu-mesa')}${spark('sp-mesa')}</article>`,
  `<article class="hc h-pine at">${tile('building', 'blue')}<div><h3>Pinecrest Dental</h3><p class="sub"><b class="fig">${pinecrest.amount}</b> ACH</p></div>`
    + `<p class="paid">${pill(`Settled ${pinecrest.settled}`)}</p>${cursor('marcus', 'cu-pine')}</article>`,
  `<article class="hc h-api at">${tile('chart', 'pink')}<div><h3>API calls</h3><p class="sub">1.2M this month</p></div>`
    + `<p class="meter"><span class="track"><span class="fill grad"></span></span><span class="pct">60%</span></p></article>`,
  `<article class="hc h-qbo at"><span class="tile dot" aria-hidden="true"></span><div><h3>QuickBooks Online</h3><p class="sub">209 payments synced</p><p class="sub">0 errors</p></div>${spark('sp-qbo')}</article>`,
]

export function hero(): string {
  const [first, second, third] = copy.rivals.map(name => `<strong>${esc(name)}</strong>`)
  return `<section class="hero" id="top" aria-labelledby="hero-title"><div class="board">`
    + `<div class="hero-copy at"><h1 id="hero-title" class="heading"><span class="l1">${esc(copy.headline[0])}</span> <span class="l2">${esc(copy.headline[1])}</span></h1>`
    + `<p class="lede">${esc(copy.subhead)}</p><p class="alt">100% free, open source alternative to ${first}, ${second} and ${third}</p>`
    + `<div class="actions"><a class="run" href="/run">${esc(copy.run)} ${ARROW}</a><a class="text-link" href="${copy.demo}">Try the demo</a><a class="text-link" href="/docs">Read the docs</a></div></div>`
    + `<div class="hero-art" aria-hidden="true"><svg class="ring at" viewBox="0 0 624 624"><circle cx="312" cy="312" r="310"/></svg><span class="shadow at"></span>`
    + `${art('hero-peach', [260, 410], 410, 435, '', 'peach at', '(min-width: 1180px) 27vw, 240px')}`
    + `${spark('sp-peach at')}${spark('sp-right at')}${spark('sp-low at')}</div>`
    + `<div class="hero-cards" role="list" aria-label="Fieldnote Software on billing day">${cards.map(card => card.replace('<article ', '<article role="listitem" ')).join('')}</div>`
    + `${sticky(['Oct 1 — all sent!'], 'st-hero at')}<svg class="st-arrow at" viewBox="0 0 60 60" aria-hidden="true"><path d="M8 52C20 44 34 30 44 12M33 13l11-2 1 11"/></svg>${spark('sp-sticky at')}`
    + `</div></section>`
}
