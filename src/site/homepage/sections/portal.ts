// 07 Portal: Pinecrest Dental upgrades itself at 2:14 pm, sees the proration
// first, and Leo's entitlements call answers the new limit (PORT-001, PORT-003,
// SUB-002, ENT-001, PORT-005, DEV-002).
import '../styles/portal.css'
import { connector, cursor, eyebrow, heading, spark, sticky, story, TICK } from '../parts'
import { pinecrest } from '../records'

const json = [
  ['granted', '<i class="t">true</i>'],
  ['limit', '<i class="n">5</i>'],
  ['plan', '<i class="s">"Group"</i>'],
  ['changed', '<i class="s">"2:14:03 pm"</i>'],
].map(([key, value], i, all) => `  <i class="k">"${key}"</i>: ${value}${i < all.length - 1 ? ',' : ''}`).join('\n')

export const portal = () => story('portal', 's-portal',
  `<div class="copy at">${eyebrow('Portal · Mon Oct 12 · 2:14 pm')}${heading('portal-title', 'Upgraded at 2:14.', 'Unlocked at 2:14.')}`
  + '<p class="body">Customers change plans in their portal and see the proration first. Your app asks Nectar what they can use, and the answer changes in seconds.</p></div>'
  + '<article class="card browser at"><p class="chrome"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="url"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10.5" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>billing.fieldnote.io</span></p>'
  + '<p class="app">Fieldnote Billing</p><div class="page"><h3>Pinecrest Dental</h3><p class="lead-in">Change plan</p>'
  + `<ul class="plans"><li><b>Practice</b><span>${pinecrest.practice} / month</span><em class="chip">Current</em></li><li class="on"><b>Group</b><span>${pinecrest.group} / month</span><em class="chip sel">${TICK}Selected</em>${cursor('leo', 'cu-leo')}</li></ul>`
  + `<dl class="preview"><div><dt>Prorated Oct 12–31</dt><dd><span class="fig">${pinecrest.prorated}</span> on your Nov 1 invoice</dd></div><div><dt>Next invoice · Sun Nov 1</dt><dd class="fig">${pinecrest.next}</dd></div><div><dt>Pay by</dt><dd>ACH · First Citizens •• 2210</dd></div></dl>`
  + '<p class="confirm">Confirm upgrade</p></div></article>'
  + connector('cn-portal at', '0 0 120 160', 'M2 150C60 150 100 110 110 2')
  + `<article class="terminal at" aria-label="Leo's entitlements request"><p class="dots" aria-hidden="true"><i></i><i></i><i></i></p><pre><code>GET /v1/entitlements/\n    pinecrest-dental/multi_location\n{\n${json}\n}</code></pre>`
  + `<p class="answered"><span class="ok">${TICK}</span>Answered in 18 ms</p></article>`
  + `${sticky(['multi-location', 'on!'], 'st-portal at', true)}${spark('sp-portal at')}`)
