// 04 Recovery: Mesa Solar's declined card retried on pay day, Pinecrest's ACH
// settling, Birch Lane's stolen card never retried (DUN-001, DUN-002, PAY-003,
// PAY-005, PORT-004).
import '../styles/recovery.css'
import { connector, cursor, eyebrow, heading, pill, spark, sticky, story, TICK } from '../parts'
import { mesa, pinecrest } from '../records'

const step = (tone: string, when: string, what: string, extra = '') => `<li class="${tone}"><p class="when">${when}</p><p class="what">${what}</p>${extra}</li>`

export const recovery = () => story('recovery', 's-recovery',
  `<div class="copy at">${eyebrow('Recovery · Thu Oct 1 → Mon Oct 5')}${heading('recovery-title', 'Declined Thursday.', 'Paid Monday.')}`
  + '<p class="body">Nectar retries each failed payment when it is most likely to clear, emails a one-click update link and never retries a stolen card.</p>'
  + `<p class="summary"><span class="ok">${TICK}</span>October: 9 failed · 9 recovered</p></div>`
  + `<article class="card c-mesa at"><header class="head"><h3>Mesa Solar · ${mesa.invoice}</h3><span class="fig">${mesa.amount}</span></header>${pill('Card declined · insufficient_funds', 'failed', false)}`
  + `<ol class="timeline">${step('red', 'Thu Oct 1, 6:00 am', `Charge declined · ${mesa.card}`)}`
  + step('grey', 'Thu Oct 1, 6:05 am', 'Payment-failed email with update link', '<p class="note">Retry table: insufficient funds → wait for pay day</p>')
  + step('green', `${mesa.retried}, 9:00 am`, `Attempt 2 of 8 · ${mesa.amount} paid ${TICK}`) + '</ol>'
  + `<p class="foot">Dunning stopped · receipt sent</p>${cursor('dana', 'cu-mesa')}${sticky(['Wait for', 'pay day ✓'], 'st-recovery')}${spark('sp-mesa')}</article>`
  + connector('cn-pine at', '0 0 52 90', 'M2 2C30 4 20 80 50 88')
  + connector('cn-birch at', '0 0 52 90', 'M2 2C30 4 20 80 50 88')
  + `<article class="card c-pine at"><h3>Pinecrest Dental · ${pinecrest.invoice}</h3><p class="sub"><span class="fig">${pinecrest.amount}</span> · ACH</p>`
  + `${pill('Pending Thu Oct 1', 'pending', false)}<p class="down" aria-hidden="true">→</p>${pill(`Settled ${pinecrest.settled}`)}${spark('sp-pine')}</article>`
  + '<article class="card c-birch at"><h3>Birch Lane Studio · FN-2190</h3><p class="sub fig">$640.00</p>'
  + `${pill('stolen_card · not retried', 'failed', false)}${pill('New card Tue Oct 6, 3:22 pm · paid', 'paid', true, 'small')}${spark('sp-birch')}</article>`)
