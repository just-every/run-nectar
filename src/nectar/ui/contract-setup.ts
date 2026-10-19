import type { Actor } from '../actor'
import { can } from '../actor'
import type { Row } from '../core'
import { formatDate, formatPeriod } from '../dates'
import { area, cents, details, form, h, hidden, table } from './html'

export function contractSetupBody(p:Row,actor:Actor) {
  const payload=p.payload,plan=payload.plan,impact=p.impact,issues=impact.unresolvedAmbiguities??[]
  const manual=payload.input.ambiguities??[]
  return h`<h2>Contract-to-billing setup</h2><p>${plan.subscription.create?'Create the quoted customer, catalog and subscription':'Apply the quoted amendment to the existing subscription'}. ${p.status==='approved'?'The approved setup is installed in ordinary billing.':'Nothing changes until approval.'}</p>
    <p>${plan.customer.name} · ${plan.customer.billingEmail}<br>Billing starts ${formatDate(plan.subscription.effectiveDate)}. ${impact.periods.length} monthly service periods are previewed.</p>
    <p class="hint">Agent-read source: ${payload.source.name} · ${payload.source.execution_reference}. Execution is buyer-recorded; Nectar has not verified a signature or signer authority.</p>
    <p class="hint">Optional original files are limited to 256,000 bytes in this installation; exact executed text is also accepted without a file.</p>
    <p><a class="download" href="/app/proposals/${p.id}/source">Download the recorded source</a></p>
    ${details({'Executed source text':payload.source.text,'Source digest':payload.source.sha256},'Read the executed source')}
    <h3>Quoted settings</h3><ul class="quotes">${impact.quotes.map((q:Row)=>h`<li><strong>${quoteLabel(q.field)}</strong><blockquote>${q.quote}</blockquote></li>`)}</ul>
    <h3>Billing setup</h3>${table(['Product','Price','Amount$','Taxable'],plan.prices.map((price:Row)=>[plan.products.find((v:Row)=>v.id===price.product)?.name??'',price.nickname||price.kind,price.pricing?price.pricing.model:`$${price.amount}`,price.taxable?'Yes':'No']))}
    <h3>Full service-period preview</h3><p>Subtotal ${cents(impact.totals.subtotalCents)} · tax ${cents(impact.totals.taxCents)} · total ${cents(impact.totals.totalCents)}.</p>
    ${table(['Year','Service period','Subtotal$','Tax$','Total$'],impact.annualTotals.map((y:Row)=>[y.year,formatPeriod(y.from,y.to),cents(y.subtotalCents),cents(y.taxCents),cents(y.totalCents)]))}
    ${table(['Service period','Subtotal$','Tax$','Total$'],impact.periods.map((v:Row)=>[formatPeriod(v.period.start,v.period.end),cents(v.calculation.subtotalCents),cents(v.calculation.taxCents),cents(v.calculation.totalCents)]))}
    <h3>Preview assumptions</h3><ul>${impact.assumptions.map((a:Row)=>h`<li>${a.label}${a.period?h` · ${a.period}: ${a.quantity}`:''}</li>`)}</ul>
    ${issues.length?h`<h3>Resolve before approval</h3><ul class="flags">${issues.map((a:Row)=>h`<li>${a.issue}${a.period?h` (${a.period})`:''}</li>`)}</ul><p>Unsupported billing terms stay blocked until Nectar can enforce them.</p>`:''}
    ${(impact.resolvedAmbiguities??[]).length?h`<h3>Recorded human resolutions</h3><ul>${impact.resolvedAmbiguities.map((a:Row)=>h`<li>${a.issue}<p>${a.resolution}</p></li>`)}</ul>`:''}
    ${p.status==='pending'&&!p.stale&&issues.length&&manual.length&&actor.kind==='member'&&can(actor,'records')?form('setup.resolve','/app/proposals/{id}',h`${hidden('proposal',p.id)}${manual.map((a:Row)=>area(a.issue,'resolution',a.resolution??'',true,3))}`,'Prepare resolved proposal',{primary:true}):''}
    ${p.result?.subscription?h`<p><a class="button" href="/app/subscriptions/${p.result.subscription}">Open the billing subscription</a></p>`:''}`
}

function quoteLabel(field:string) {
  const [kind,key]=field.split('.')
  const labels:Record<string,string>={customer:'Customer',subscription:'Subscription and service dates',catalog:'Catalog price',items:'Service item',ramps:'Dated item change',commitments:'Minimum commitment',included:'Included usage',exceptions:'Contract exception',usage_assumptions:'Usage scenario'}
  return `${labels[kind]??kind}${key===undefined?'':` ${/^\d+$/.test(key)?Number(key)+1:key}`}`
}
