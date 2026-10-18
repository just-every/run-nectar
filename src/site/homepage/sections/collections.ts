// 05 Collections: Cedar & Pine's bounced invoice resent to the right AP inbox,
// Lumen Health's Coupa PO and Orchard Labs' promise to pay (AGENT-003, INV-002,
// AR-001, AR-005, PAY-007).
import '../styles/collections.css'
import { connector, cursor, eyebrow, heading, pill, spark, sticky, story, TICK } from '../parts'

const step = (tone: string, when: string, what: string) => `<li class="${tone}"><p class="when">${when}</p><p class="what">${what}</p></li>`
const stage = (what: string, when: string) => `<li><span class="dot" aria-hidden="true"></span><p><b>${what}</b><span>${when}</span></p></li>`

export const collections = () => story('collections', 's-collections',
  `<article class="card c-cedar at"><header class="head"><h3>Cedar &amp; Pine · FN-2112</h3></header><p class="terms"><span class="fig">$8,415.00</span> · Net 15</p><ol class="timeline">`
  + step('red', 'Thu Oct 1, 6:01 am', 'Invoice email to their ap@ inbox bounced')
  + step('orange', 'Agent', 'AP moved to their payables@ inbox<br>(their email of Sep 22)')
  + step('ink', 'Tue Oct 6, 9:14 am', 'Dana approved the new contact')
  + step('ink', '9:15 am', 'Invoice resent · opened 10:02 am')
  + step('green', 'Wed Oct 14', `Paid by ACH credit ${TICK}`)
  + `</ol>${cursor('dana', 'cu-cedar')}${sticky(['AP moved', 'in Sept!'], 'st-collections', true)}${spark('sp-cedar')}</article>`
  + connector('cn-lumen at', '0 0 112 176', 'M0 2H104Q110 2 110 8V176')
  + connector('cn-orchard at', '0 0 44 150', 'M44 2H8Q2 2 2 8V142Q2 148 8 148H44')
  + `<article class="card c-lumen at"><header class="head"><h3>Lumen Health · FN-2150</h3><span class="fig">$12,600.00 · PO 4471</span></header>`
  + `<ol class="stages">${stage('Sent to Coupa', 'Thu Oct 1')}${stage('Approved', 'Fri Oct 9')}<li class="done"><span class="dot" aria-hidden="true"></span>${pill('Paid · Fri Oct 23')}</li></ol></article>`
  + `<article class="card c-orchard at"><p><b>Orchard Labs</b><span> · promised to pay Fri Oct 16 · reminders paused</span></p>${pill('Paid')}</article>`
  + `<div class="copy at">${eyebrow('Collections · Oct 1 → Oct 23')}${heading('collections-title', 'Chased to the', 'right person.')}`
  + `<p class="body">The collections agent finds why an invoice is unpaid, asks the right person for the missing piece and checks that it lands.</p>${spark('sp-copy')}</div>`)
