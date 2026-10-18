// 10 Moving in: the August shadow month beside Stripe Billing, adoption on
// Tue Sep 1, and the one-line start (NEC-16, MOVE-005, MOVE-006, MOVE-010,
// MOVE-011, MOVE-001–004). The terminal shows only the start line and a plain
// comment: no rer output, no RER_* lines and no local URLs.
import '../styles/move-in.css'
import { connector, cursor, eyebrow, heading, spark, sticky, story, TICK } from '../parts'
import run from '../../run.json'

const step = (when: string, what: string, last = false) => `<li${last ? ' class="now"' : ''}><p class="when">${when}</p><p class="what">${what}</p></li>`

export const moveIn = () => story('moving-in', 's-move',
  `<article class="card c-move at"><h3>Stripe Billing → Nectar</h3><ol class="timeline">`
  + step('Sat Aug 1', 'Shadow run starts · 212 subscriptions')
  + step('Aug 1–31', 'Usage relayed to Stripe · 37,918,552 events · 0 differences')
  + step('Tue Sep 1, 12:00 am', '201 August invoices shadow-rated · 200 equal to the cent · 1 explained (+$0.01 rounding)')
  + step('Tue Sep 1', `212 subscriptions adopted · Stripe bills no September period ${TICK}`, true)
  + `</ol><ul class="facts"><li>${TICK}168 payment methods reused · 0 customers asked</li><li>${TICK}Numbering continues · FN-1834 → FN-1835</li></ul>`
  + `${cursor('dana', 'cu-move')}${sticky(['same cards,', 'same numbers'], 'st-move')}${spark('sp-move1')}${spark('sp-move2')}${spark('sp-move3')}</article>`
  + `<div class="copy at">${eyebrow('Moving in · August')}${heading('moving-in-title', 'Off Stripe Billing', 'in one shadow month.')}`
  + '<p class="body">Nectar reads your Stripe account, bills August in shadow beside it and takes over at the period boundary. Cards stay where they are.</p></div>'
  + connector('cn-move at', '0 0 100 110', 'M2 2C40 10 50 80 90 104', true)
  + `<figure class="terminal at"><p class="dots" aria-hidden="true"><i></i><i></i><i></i></p><pre aria-label="Start Nectar"><code><span class="prompt" aria-hidden="true">$ </span>${run.clone}\n<span class="comment"># installs and starts Nectar on your computer</span></code></pre>${spark('sp-term')}</figure>`
  + '<p class="also at">Also moves in from Chargebee, Recurly, Maxio, Orb and Metronome</p>')
