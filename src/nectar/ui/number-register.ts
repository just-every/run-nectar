import type { Bindings } from '../../auth.server'
import { can, type Actor } from '../actor'
import { plainMoney } from '../decimal'
import { numberRegister, type NumberRegisterEntry } from '../number-register'
import { h, page, select, table } from './html'
import { all } from '../core'
import { invoiceSeriesForms } from './invoice-series'

// Explicit wrap opportunities preserve every character of long provider numbers.
const wrap = (value: string | null) => value ? h`<span>${Array.from(value).map((character, index) => h`${index && index % 8 === 0 ? h`<wbr>` : ''}${character}`)}</span>` : h`<span>No number recorded</span>`
const kindName = (value: string) => value === 'credit-note' ? 'Credit note' : 'Invoice'
const document = (entry: NumberRegisterEntry) => h`<a href="${entry.href}">${wrap(entry.number)}</a>`
const origin = (entry: NumberRegisterEntry) => h`<span>${wrap(entry.source)} · ${wrap(entry.sourceReference)}<br>Record ${wrap(entry.id)}</span>`
const amount = (entry: NumberRegisterEntry) => h`<span>${plainMoney(entry.totalCents)}<br>${entry.currency || 'Currency not retained'}</span>`

export async function numberRegisterPage(env: Bindings, actor: Actor, url: URL) {
  const register = await numberRegister(env, actor, url)
  const entities = await all(env, 'SELECT id,legal_name FROM nc_billing_entities ORDER BY legal_name,id')
  const entityName = (id: string | null) => id ? entities.find(row=>row.id===id)?.legal_name ?? id : 'Installation business'
  const filter = url.searchParams.get('entity') ?? ''
  return page('Number register', actor, h`<h1>Number register</h1>
    <p class="lede">Imported invoices, issued Nectar invoices and credit notes.</p>
    <form method="get" action="/app/numbering" class="row-form">${select('Register entity','entity',[{value:'business',label:'Installation business'},...entities.map(row=>({value:row.id,label:row.legal_name}))],filter,{required:false,blank:'All entities'})}<button type="submit">Filter register</button></form>
    ${can(actor, 'export') ? h`<p><a href="/app/exports/number-register.csv${filter ? `?entity=${encodeURIComponent(filter)}` : ''}">Download register and gaps CSV</a></p>` : ''}
    <section class="card"><h2>What this register covers</h2>
      <p>All ${register.entries.length} stored records are listed below, including imported records in every status. Draft Nectar invoices are excluded. Credit amounts are positive as recorded.</p>
      <p>Number series share an entity, exact prefix, digit width and document kind across sources. Missing ranges are inclusive and only between the smallest and largest recorded suffix. They identify absent numbers in these records; they do not prove a document was issued or deleted.</p>
      <p>Currency and credit tax appear where source captures retain them. The CSV includes stored amount fields in cents and entity identifiers. Settings evidence records its owner or API provenance; the register alone does not verify live processor configuration.</p>
    </section>
    ${await invoiceSeriesForms(env, actor)}
    <section class="card"><h2>Series</h2>
      ${table(['Entity','Kind', 'Exact prefix', 'Digits', 'First suffix', 'Last suffix', 'Records', 'Distinct numbers'], register.series.map(s => [entityName(s.entityId),kindName(s.kind), s.prefix ? wrap(s.prefix) : '(empty prefix)', s.width, wrap(s.firstSuffix), wrap(s.lastSuffix), s.recordedCount, s.distinctCount]), { empty: 'No numbers with a terminal numeric suffix.' })}
    </section>
    <section class="card"><h2>Missing ranges</h2>
      ${table(['Entity','Kind', 'From (inclusive)', 'To (inclusive)', 'Missing numbers'], register.gaps.map(gap => [entityName(gap.entityId),kindName(gap.kind), wrap(gap.from), wrap(gap.to), wrap(gap.count)]), { empty: 'No internal gaps in the recorded series.' })}
    </section>
    <section class="card"><h2>Duplicate numbers</h2><p>Exact repeated numbers are shown across every source and document kind. Each recorded row remains in the register.</p>
      ${table(['Number', 'Kind', 'Source and reference', 'Customer'], register.duplicates.flatMap(group => group.entries.map(entry => [document(entry), kindName(entry.kind), origin(entry), wrap(entry.customerId)])), { empty: 'No repeated non-empty numbers.' })}
    </section>
    <section class="card"><h2>Unparsed numbers</h2><p>Missing numbers and values without a terminal numeric suffix are listed here. They are excluded from series and gap calculations.</p>
      ${table(['Number', 'Kind', 'Source and reference'], register.unparsed.map(entry => [document(entry), kindName(entry.kind), origin(entry)]), { empty: 'Every recorded number has a terminal numeric suffix.' })}
    </section>
    <section class="card"><h2>Register</h2>
      ${table(['Number', 'Entity','Kind', 'Source and reference', 'Customer ID', 'Recorded total / credit amount'], register.entries.map(entry => [document(entry),entityName(entry.entityId), kindName(entry.kind), origin(entry), wrap(entry.customerId), amount(entry)]), { empty: 'No imported invoices, issued invoices or credit notes are recorded.', lead: true })}
    </section>`, { url, current: '/app/billing' })
}
