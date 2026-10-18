// 02 Billing day: the October bill run card and the three exceptions a person
// resolved the evening before (INV-001, NEC-09, USE-007, INV-004, TAX-001).
import '../styles/billing-day.css'
import { connector, eyebrow, heading, pill, row, spark, sticky, story, tile, cursor, TICK } from '../parts'
import { run } from '../records'

const exception = (who: string, what: string) => `<li><p><b>${who}</b> · ${what}</p><span class="ok" aria-label="resolved">${TICK}</span></li>`

export const billingDay = () => story('billing-day', 's-billing',
  `<div class="copy at">${eyebrow('Billing day · Thu Oct 1 · 6:00 am')}${heading('billing-day-title', '212 invoices,', 'out by six.')}`
  + '<p class="body">Nectar prepares the run the evening before. Clean invoices issue on their own; anything unusual waits for you.</p></div>'
  + `<article class="card c-exc at"><h3 class="exc-head">${tile('check', 'mint')}<span><b>3 exceptions</b> · resolved Wed 7:12 pm</span></h3><ul>`
  + exception('Lumen Health', 'PO number required → PO 4471 added')
  + exception('Cedar &amp; Pine', '+38% vs September → 15 seats added Sep 18')
  + exception('Harbor Analytics', 'Sep 29 usage short 2,140 events → replayed')
  + `</ul>${cursor('dana', 'cu-exc')}${spark('sp-exc')}</article>`
  + connector('cn-billing at', '0 0 100 130', 'M2 128C4 70 40 20 98 2')
  + `<article class="card c-billrun at"><header class="run-head">${tile('invoice', 'coral', 'big')}<h3>October bill run</h3>${pill('Issued')}</header>`
  + `<p class="meta">Prepared ${run.prepared} · Issued ${run.issued}</p>`
  + `<div class="stats"><p><b class="fig">${run.invoices}</b><span>invoices</span></p><p><b class="fig">${run.total}</b><span>billed</span></p></div>`
  + '<p class="meter"><span class="track"><span class="fill green"></span></span><span class="pct">100%</span></p>'
  + `<div class="lines">${row('Plans and seats', run.plans)}${row('Usage', run.usage)}${row(`Sales tax · ${run.taxedInvoices} invoices`, run.tax)}${row('Total', run.total, 'row total')}</div>`
  + `<ul class="chips"><li>${tile('card', 'blue')}Card ${run.card}</li><li>${tile('bank', 'blue')}ACH ${run.ach}</li><li>${tile('file', 'blue')}Invoice terms ${run.terms}</li></ul>`
  + `<p class="prior">September: ${run.september.invoices} invoices · ${run.september.total}</p>`
  + `${sticky(['clean ones go out', 'on their own'], 'st-billing')}${spark('sp-billing')}</article>`)
