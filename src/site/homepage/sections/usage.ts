// 06 Mascot moment (no heading, centred): October's usage events streaming in
// as beads from three sources, ticked once each into the ledger by the small
// two-tone peach, and leaving as the Nov 1 invoices (USE-001, USE-003).
import '../styles/usage.css'
import { pill, spark, sticky, tile } from '../parts'
import { lakeview, usage } from '../records'
import { art } from './hero'

const source = (icon: Parameters<typeof tile>[0], tone: Parameters<typeof tile>[1], name: string, count: string, className: string) =>
  `<li class="card src ${className} at">${tile(icon, tone)}<p><b>${name}</b><span>${count}</span></p></li>`
// Each stream: a dashed path with coral and tangerine beads along it, in desk pixels.
const beads = (points: [number, number][]) => points.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="11" class="${i % 2 ? 'b2' : 'b1'}"/>`).join('')

export const usageMoment = () => `<section class="story s-usage" id="usage" aria-labelledby="usage-title"><div class="board">`
  + `<div class="total card at"><h2 id="usage-title"><span class="fig">${usage.total}</span> October usage events</h2>${pill('each billed once')}</div>`
  + `<ul class="sources">${source('chart', 'pink', 'API', `${usage.api} events`, 's-api')}${source('code', 'blue', 'SDK', `${usage.sdk} events`, 's-sdk')}${source('file', 'yellow', 'S3 file · Oct 31', `${usage.rows} rows`, 's-s3')}</ul>`
  + '<svg class="streams at" viewBox="0 0 1536 833" aria-hidden="true">'
  + '<path d="M382 326C470 330 520 380 560 440S600 500 625 505M382 480C440 476 500 500 540 520S600 545 628 550M382 636C440 630 480 600 540 585S600 570 628 568M938 588C980 580 1000 560 1040 540S1080 520 1108 515"/>'
  + beads([[418, 330], [455, 349], [488, 372], [548, 440], [568, 467], [414, 478], [455, 479], [488, 491], [529, 511], [576, 538], [424, 627], [476, 606], [517, 590], [1011, 559], [1046, 536], [1082, 520]]) + '</svg>'
  + `<div class="mascot at">${art('usage-peach', [360, 595], 595, 450, 'The Nectar peach at a desk, ticking each usage bead once into an open ledger', 'lazy', '(min-width: 1180px) 37vw, 340px')}${sticky(['no doubles!'], 'st-usage', true)}</div>`
  + `<div class="stack at"><span class="sheet s3" aria-hidden="true"></span><span class="sheet s2" aria-hidden="true"></span><article class="card top">${tile('invoice', 'blue')}<p><b>${lakeview.next} · Lakeview Freight</b><span>API calls · Oct 1–31</span>${pill('Ready for Nov 1')}</p></article></div>`
  + `${spark('sp-u1 at')}${spark('sp-u2 at')}${spark('sp-u3 at')}${spark('sp-u4 at')}${spark('sp-u5 at')}</div></section>`
