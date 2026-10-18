// 11 Closing (centred): "Ready for the 1st." between the locked October close
// and the scheduled December run, with the small peach peeking in at the lower
// right holding a desk calendar for Tue Dec 1. The footer is set in type.
import '../styles/closing.css'
import { esc } from '../../shell'
import { copy } from '../copy'
import { ARROW, connector, pill, spark, tile } from '../parts'
import { art } from './hero'

export const closing = () => `<section class="story s-closing" aria-labelledby="closing-title"><div class="board">`
  + `<article class="card c-locked at">${tile('lock', 'mint', 'big')}<p><b>October close</b>${pill('Locked')}</p></article>`
  + `<article class="card c-dec at">${tile('clock', 'grey', 'big')}<p><b>December bill run</b><span>scheduled · 6:00 am</span></p></article>`
  + connector('cn-dec at', '0 0 140 150', 'M128 2C134 60 100 90 60 110S10 140 2 148')
  + `<div class="end at"><h2 id="closing-title" class="heading"><span class="l1">${esc(copy.closing.first)}</span> <span class="l2">${esc(copy.closing.second)}</span></h2>`
  + `<p class="small">${esc(copy.closing.small)}</p><div class="actions"><a class="run" href="/run">${esc(copy.run)} ${ARROW}</a><a class="text-link" href="/docs">${esc(copy.docs)}</a></div></div>`
  + `<div class="peek at">${art('closing-peach', [300, 468], 468, 376, 'The Nectar peach with a coffee mug, holding a desk calendar', 'lazy', '(min-width: 1180px) 30vw, 220px')}`
  + '<p class="calendar" aria-label="Desk calendar: Tuesday, December 1"><span>DEC</span><b>1</b><span>Tuesday</span></p></div>'
  + `${spark('sp-end at')}${spark('sp-lock at')}</div></section>`
