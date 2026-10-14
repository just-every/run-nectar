// The landing's drawings: real HTML in frosted glass cards over the honey glow.
// Every string is a label or a figure the product shows; badge
// numerals and the honeycomb are decoration, hidden from assistive technology.

const HEX = 'M17 1.5 32 10.2v17.6L17 36.5 2 27.8V10.2Z'
const hexagon = (numeral = '') => `<span class="hx" aria-hidden="true"><svg viewBox="0 0 34 38"><path d="${HEX}" fill="#F6B23E" stroke="#F6B23E" stroke-width="2" stroke-linejoin="round"/><path d="M17 1.5 32 10.2v8.8H2v-8.8Z" fill="#FBCB6E" opacity=".55"/></svg>${numeral ? `<b>${numeral}</b>` : ''}</span>`
const glass = (body: string, extra = '') => `<div class="glass${extra ? ` ${extra}` : ''}">${body}</div>`
const row = (label: string, value: string) => `<div class="row"><span>${label}</span><span class="fig">${value}</span></div>`

// July: 31 day cells in three rows of 11, 10 and 10 across the card, the
// middle row offset by half a cell; the five days without usage are hollow.
const QUIET_DAYS = new Set([4, 11, 25, 26, 30])
const ROW_STARTS = [1, 12, 22]
function honeycomb(): string {
  const r = 11, w = r * Math.sqrt(3), cells: string[] = []
  for (let day = 1; day <= 31; day++) {
    const line = day >= ROW_STARTS[2] ? 2 : day >= ROW_STARTS[1] ? 1 : 0, column = day - ROW_STARTS[line]
    const cx = w / 2 + 2 + column * (w + 3) + (line % 2 ? (w + 3) / 2 : 0), cy = r + 2 + line * (r * 1.5 + 2.6)
    const points = [0, 1, 2, 3, 4, 5].map(i => { const a = Math.PI / 3 * i - Math.PI / 2; return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}` }).join(' ')
    cells.push(QUIET_DAYS.has(day) ? `<polygon points="${points}" fill="none" stroke="#F2B347" stroke-width="1.4"/>` : `<polygon points="${points}" fill="#F6B23E"/>`)
  }
  return `<svg class="comb" viewBox="0 0 ${Math.ceil(11 * (w + 3) + 1)} ${Math.ceil(2 * (r * 1.5 + 2.6) + 2 * r + 4)}" aria-hidden="true">${cells.join('')}</svg>`
}

/** The hero: one customer's July from usage to an issued invoice. */
export const heroFlow = () => `<figure class="flow" aria-label="Northwind Robotics' July: usage rated line by line into invoice INV-000042, issued for $2,151.70">`
  + glass(`<h3>${hexagon('1')}Usage</h3><p class="who">Northwind Robotics</p><p class="muted">3,346,778.5 events</p>${honeycomb()}<p class="month">JULY</p>`, 'step usage')
  + glass(`<h3>${hexagon('2')}Rated</h3>${row('Core plan', '$499.00')}${row('5 seats × $30.00', '$150.00')}${row('3,346,778.5 × $0.0004', '$1,338.71')}${row('Tax 8.25%', '$163.99')}`, 'step rated')
  + glass(`<h3>${hexagon('3')}Issued</h3><p class="who">Invoice INV-000042</p><p><span class="chip">Issued</span></p><p class="total fig">$2,151.70</p>`, 'step issued')
  + '</figure>'

export const licenceCard = () => glass(`<div class="licence">${hexagon()}<div><p class="title">MIT License</p><p>Permission is hereby granted, free of charge</p></div></div><span class="bar" aria-hidden="true"></span><span class="bar" aria-hidden="true"></span><span class="bar short" aria-hidden="true"></span>`)

export const chargesCard = () => glass(`<p class="title">Charges</p><div class="grid charges" role="table" aria-label="Charges">`
  + '<div class="head" role="row"><span role="columnheader">Charge</span><span role="columnheader">Quantity</span><span role="columnheader">Unit</span><span role="columnheader" class="fig">Amount</span></div>'
  + '<div class="open" role="row"><span role="cell"><b><i class="caret" aria-hidden="true"></i>Event processing (v1)</b><small>3,346,778.5 events</small></span><span role="cell" class="fig">3,346,778.5</span><span role="cell" class="fig">$0.0004</span><span role="cell" class="fig"><b>$1,338.71</b></span></div>'
  + '</div><div class="rule"><p class="label">Rule</p><p>sum of event quantities × unit, rounded half away from zero once</p><span class="bar" aria-hidden="true"></span><span class="bar short" aria-hidden="true"></span></div>')

export const monthCard = () => glass(`<p class="title">July 2026 bill run</p><dl class="figs"><div><dt>Invoices</dt><dd class="fig">24</dd></div><div><dt>Total</dt><dd class="fig">$48,310.25</dd></div><div><dt>vs June 2026</dt><dd class="fig"><span class="up" aria-hidden="true">↑</span> +$1,204.10</dd></div></dl>`
  + '<div class="inner"><div><p class="label">Exceptions</p><p>No exceptions. Every draft rated cleanly.</p></div><span class="pill dark">Approve clean drafts</span></div>')

export const shadowCard = () => glass('<p class="title">Shadow and cutover</p><div class="inner line"><span class="who">Northwind Robotics</span><span class="chip">Reconciled</span><span class="pill">Adopt</span></div><p class="muted small">Previous biller agrees on every price.</p>')

export const owedCard = () => glass(`<div class="grid owed" role="table" aria-label="Ageing by customer">`
  + '<div class="head" role="row"><span role="columnheader">Customer</span><span role="columnheader" class="fig">Not yet due</span><span role="columnheader" class="fig">1–30 days</span><span role="columnheader" class="fig">31–60 days</span><span role="columnheader" class="fig">Owed</span></div>'
  + '<div role="row"><span role="cell">Pinecrest Labs</span><span role="cell" class="fig" data-label="Not yet due">$273.65</span><span role="cell" class="fig" data-label="1–30 days">$1,151.70</span><span role="cell" class="fig" data-label="31–60 days">$0.00</span><span role="cell" class="fig" data-label="Owed"><b>$1,425.35</b></span></div>'
  + '</div><p class="end"><span class="pill">Draft reminder</span></p>')

export const included = (items: string[]) => `<ul class="tiles">${items.map(item => `<li class="glass tile">${hexagon()}<span>${item}</span></li>`).join('')}</ul>`
