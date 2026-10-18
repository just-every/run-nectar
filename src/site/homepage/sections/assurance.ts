// 08 Revenue assurance: case RA-0031, Lakeview's missed ramp step caught
// against the signed order form, fixed and explained on Dana's approval
// (AGENT-001, AGENT-002, CRM-002, CAT-003).
import '../styles/assurance.css'
import { connector, cursor, eyebrow, heading, pill, row, spark, story, tile, TICK } from '../parts'
import { lakeview } from '../records'

const check = (label: string, value: string, found = false) => `<li${found ? ' class="found"' : ''}><span class="mark" aria-hidden="true">${found ? '' : TICK}</span><span>${label}</span><span class="fig">${value}</span></li>`

export const assurance = () => story('assurance', 's-assurance',
  `<div class="copy at">${eyebrow('Revenue assurance · Thu Oct 15')}${heading('assurance-title', 'A missed ramp,', 'caught and fixed.')}</div>`
  + '<p class="body at">An agent compares signed terms, usage, access, invoices and payments for every customer, opens a case for each mismatch and drafts the fix. You approve it.</p>'
  + `<article class="card c-case at"><header class="head">${tile('search', 'coral', 'big')}<h3>Case RA-0031 <span>· Lakeview Freight</span></h3>${pill('Under-billed $1,200.00', 'failed', false)}</header>`
  + '<div class="cols"><section class="col"><h4>Signed order form</h4><p class="sub">Sep 24, 2025<br>§3.2</p><blockquote>“Seats: $95 per seat per month through Sep 30, 2026; $120 from Oct 1, 2026.”</blockquote>'
  + `<p class="billed"><span class="tile red" aria-hidden="true">!</span><span>Invoice ${lakeview.invoice}<br>billed ${lakeview.seats} × ${lakeview.seatPrice}</span></p></section>`
  + `<section class="col"><h4>Proposed fix</h4><p class="sub">Nov 1 invoice · October catch-up</p><p class="calc fig">48 × $25.00 = $1,200.00</p><div class="lines">${row('Seat price from Nov 1', '$120.00')}${row('MRR', '+$1,200')}${row('Sales tax', '$0.00')}</div></section>`
  + '<section class="col"><h4>Email to Grace Liu</h4><blockquote class="mail">“Your order form moves seats to $120 from October 1. Your October invoice used $95, so your November 1 invoice adds a one-time $1,200.00 catch-up (48 seats × $25). Nothing else changes.”</blockquote></section></div>'
  + `<footer class="approve"><p class="ok-bar"><span class="ok">${TICK}</span><span><b>Approved by Dana Brooks</b> · Fri Oct 16, 10:12 am</span>${TICK}</p><p class="sent">Fix and email sent together.</p>${cursor('dana', 'cu-case')}</footer>${spark('sp-case')}</article>`
  + connector('cn-checks at', '0 0 190 30', 'M2 28C50 -6 140 -6 188 28')
  + `<article class="card c-checks at"><header class="head">${tile('ledger', 'blue', 'big')}<h3>October checks<span>212 customers</span></h3></header><ul>`
  + check('Signed terms vs invoices', '1 case', true) + check('Usage vs source totals', '0') + check('Access without payment', '0') + check('Credits never applied', '0') + check('Commitments not trued up', '0')
  + `</ul>${spark('sp-checks1')}${spark('sp-checks2')}</article>`)
