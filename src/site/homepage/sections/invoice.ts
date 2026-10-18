// 03 One invoice: Lakeview Freight's FN-2041 with seats, graduated API calls,
// the calculation evidence and the September quota (NEC-07, CAT-001, CAT-002,
// USE-001, ENT-002).
import '../styles/invoice.css'
import { cursor, eyebrow, heading, spark, story, tile, TICK } from '../parts'
import { lakeview } from '../records'

const line = (what: string, when: string, qty: string, amount: string) => `<p class="ln"><span><b>${what}</b> · ${when}</span><span class="qty">${qty}</span><span class="fig">${amount}</span></p>`
const tier = (what: string, amount: string) => `<p class="tier"><span>${what}</span><span class="lead" aria-hidden="true"></span><span class="fig">${amount}</span></p>`

export const invoice = () => story('one-invoice', 's-invoice',
  `<article class="card c-inv at"><header class="inv-head">${tile('invoice', 'coral', 'big')}<h3>Invoice ${lakeview.invoice}</h3><span class="from">Fieldnote Software</span></header>`
  + '<p class="who"><b>Lakeview Freight</b><span>Issued Thu Oct 1, 2026 · Due on receipt</span></p>'
  + `<div class="lines">${line('Team seats', 'Oct 1–31', `${lakeview.seats} × ${lakeview.seatPrice}`, lakeview.seatsTotal)}${line('API calls', 'Sep 1–30', `${lakeview.calls} calls`, lakeview.callsTotal)}`
  + `${tier('First 1,000,000 at $2.00 per 1,000', lakeview.tierOne)}${tier('Next 200,000 at $1.40 per 1,000', lakeview.tierTwo)}`
  + '<p class="ln tax"><span>Sales tax (Avalara)</span><span class="fig">$0.00</span></p></div>'
  + `<p class="ln total"><span>Total</span><span class="fig">${lakeview.total}</span></p>`
  + `<p class="paidbar"><span class="ok">${TICK}</span>Paid by card · ${lakeview.card} · ${lakeview.paid}</p>${spark('sp-inv')}</article>`
  + '<svg class="connector cn-tiers at" viewBox="0 0 40 110" preserveAspectRatio="none" aria-hidden="true"><path d="M2 108C14 90 18 60 38 2M2 70C18 60 24 40 38 30"/></svg>'
  + `<article class="card c-calc at"><h3 class="calc-head">${tile('calculator', 'coral')}Calculation</h3><dl>`
  + '<div><dt>Rule</dt><dd>nectar-rating-1</dd></div><div><dt>Inputs fingerprint</dt><dd>9c41…e07b</dd></div>'
  + `<div><dt>Events billed once</dt><dd class="fig">${lakeview.calls}</dd></div><div><dt>Duplicates ignored</dt><dd class="fig">3,118</dd></div></dl>${cursor('marcus', 'cu-calc')}${spark('sp-calc')}</article>`
  + `<article class="card c-quota at"><h3 class="calc-head">${tile('chart', 'coral')}<span>API calls · September<small>1.2M of 2M</small></span></h3>`
  + `<p class="meter"><span class="track"><span class="fill grad"></span></span><span class="pct">60%</span></p>${spark('sp-quota')}</article>`
  + `<div class="copy at">${eyebrow(`One invoice · ${lakeview.invoice}`)}${heading('one-invoice-title', 'Every line', 'shows its math.')}`
  + '<p class="body">Seats, tiers and usage are rated exactly, to the cent, and every invoice keeps the inputs that made it.</p></div>')
