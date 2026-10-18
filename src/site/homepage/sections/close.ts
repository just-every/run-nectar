// 09 Month-end: the October close packet handed to Marcus Webb, CPA, and the
// MRR movement (AGENT-008, REV-001, REV-002, BOOK-001, PAY-004, TAX-003, RPT-001).
import '../styles/close.css'
import { connector, cursor, eyebrow, heading, pill, spark, sticky, story, tile, TICK } from '../parts'
import { close, run } from '../records'
import type { IconName } from '../icons'

const item = (icon: IconName, label: string, value: string, open = false) =>
  `<li${open ? ' class="open"' : ''}>${tile(icon, open ? 'grey' : 'mint')}<span class="lbl">${label}</span><span class="val"><span class="fig">${value}</span><span class="st" aria-label="${open ? 'open' : 'tied out'}">${open ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' : TICK}</span></span></li>`

export const monthEnd = () => story('month-end', 's-close',
  `<div class="copy at">${eyebrow('Month-end · Mon Nov 2')}${heading('month-end-title', 'October,', 'tied out by&nbsp;Monday.')}`
  + '<p class="body">The close agent ties invoices, payments, payouts, tax, the ledger and revenue together, and hands your accountant one packet.</p></div>'
  + `<article class="card c-mrr at"><p class="k">MRR</p><p class="mrr fig">${close.mrrFrom} → ${close.mrrTo}</p>`
  + `<p class="bar up"><span class="track"><span class="fill"></span></span><span class="txt"><b class="fig">${close.expansion}</b> expansion</span></p>`
  + `<p class="bar down"><span class="track"><span class="fill"></span></span><span class="txt"><b class="fig">${close.churn}</b> churn</span></p>${spark('sp-mrr')}</article>`
  + connector('cn-close at', '0 0 120 140', 'M2 130C60 130 70 10 116 4')
  + `<article class="card c-close at"><header class="head"><h3>October close <span><span class="sep">· </span>ready for Marcus Webb, CPA</span></h3>${pill('Locked')}</header><ul class="items">`
  + item('invoice', `Billed · ${run.invoices} invoices`, run.total)
  + item('card', `Collected · ${close.paid} paid`, close.collected)
  + item('clock', 'Open · 3 invoices · Net 60 · due Mon Nov 30', close.open, true)
  + item('coins', 'Stripe payouts · 6', `${close.payouts} + ${close.fees} fees`)
  + item('ledger', 'QuickBooks Online', `${run.invoices} invoices · ${close.paid} payments · 0 errors`)
  + item('percent', 'Sales tax · 14 states', `${run.tax} · report ready to file`)
  + item('chart', 'Deferred revenue', '$96,000 → $88,000')
  + `</ul><p class="break"><span class="spark-in" aria-hidden="true"></span><span><b>1 break found:</b> Fri Oct 9 payout fee $38.12 missing in QuickBooks → synced</span>${TICK}</p>`
  + `<p class="locked">Locked by Dana Brooks · Mon Nov 2, 4:30 pm</p>${cursor('marcus', 'cu-close')}${sticky(['done by', 'Monday!'], 'st-close', true)}${spark('sp-close')}</article>`)
