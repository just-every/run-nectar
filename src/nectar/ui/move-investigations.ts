import type { Bindings } from '../../auth.server'
import { can, requireCapability, type Actor } from '../actor'
import { all, type Row } from '../core'
import { assuranceCases } from '../assurance'
import { MOVE_KIND, moveInvestigationEvidence } from '../movein/investigations'
import { cents, details, form, h, hidden, page, select, table, tag } from './html'

const labels:Record<string,string>={quantity:'Quantity',unitAmount:'Unit price',from:'Service starts',to:'Service ends',amountCents:'Line amount',missing_line:'Missing engine line',additional_lines:'Additional engine lines'}
const value=(field:string,item:unknown)=>field==='amountCents'&&typeof item==='number'?cents(item):typeof item==='object'?'Requires review':String(item??'Unavailable')
export async function moveInvestigationsPage(env:Bindings,actor:Actor,url:URL) {
  requireCapability(actor,'read')
  const proofs=await moveInvestigationEvidence(env),cases=(await assuranceCases(env,actor)).filter(row=>row.kind===MOVE_KIND)
  const people=await all(env,"SELECT id,name FROM nc_members WHERE status='active' AND role IN ('owner','finance') ORDER BY name,id")
  const back='/app/import/investigations',investigator=can(actor,'propose'),approver=actor.kind==='member'&&can(actor,'approve')
  return page('Move-in investigations',actor,h`<p class="crumbs"><a href="/app/import">Move in</a></p><h1>Move-in investigations</h1>
    <p>Compare uploaded Stripe monthly fixed and seat invoice lines with current Nectar calculations. These comparisons issue no invoice and authorize no charge or cutover. Unsupported or incomplete captures need separate review.</p>
    ${investigator?form('move.investigate',back,select('Assign new cases to','owner',people.map(person=>({value:person.id,label:person.name})),actor.kind==='member'?actor.id:people[0]?.id),'Investigate captured invoices'):''}
    <section class="card"><h2>Current comparisons</h2>${table(['Captured invoice','Result','Differences'],proofs.map(proof=>[h`<a href="/app/customers/${proof.customer}#history-${proof.capturedInvoice}">${proof.invoiceReference??'Captured invoice'}</a>`,tag(proof.mismatch?'Needs investigation':'Agrees'),proof.differences.length]),{empty:'No supported shadow comparisons are available.'})}</section>
    ${cases.map(row=>{
      const live=proofs.find(proof=>proof.source===row.source_id),proof:Row=live??row.evidence,stale=!live||live.basis!==row.basis_hash
      return h`<section class="card" data-move-case="${row.id}"><h2>${proof.invoiceReference??'Captured invoice'} · ${tag(row.status)}</h2>
        <p>Assigned to ${people.find(person=>person.id===row.owner_id)?.name??'Unavailable assignee'}. ${stale?'Saved explanation is stale. Recheck before confirmation.':'Explanation matches the current sources.'}</p>
        ${table(['Difference','Captured Stripe fact','Current Nectar input'],proof.differences.map((difference:Row)=>[labels[difference.field]??difference.field,value(difference.field,difference.captured),value(difference.field,difference.engine)]),{empty:live?'The captured lines and current calculation agree. Human confirmation and recheck are still required.':'Comparison source is unavailable.'})}
        <details><summary>Source citations and retained facts</summary><p>Captured invoice ${proof.invoiceReference}. Row ${proof.citation.row} in source artifact ${proof.citation.artifactHash}.</p>
          ${proof.comparisons.map((comparison:Row)=>h`<p>Source line ${comparison.captured.line}, price ${comparison.captured.price}: ${comparison.captured.quantity} at $${comparison.captured.unitAmount}, ${comparison.captured.from} to ${comparison.captured.to}, ${cents(comparison.captured.amountCents)}.</p>`)}
          ${details({'Import job':proof.citation.job,'Source object hash':proof.citation.sourceHash,'Engine basis':proof.engineBasis,'Comparison basis':proof.basis})}</details>
        ${approver?form('assurance.assign',back,h`${hidden('case',row.id)}${select('Case owner','owner',people.map(person=>({value:person.id,label:person.name})),row.owner_id)}`,'Assign case',{secondary:true}):''}
        ${approver&&live&&!live.mismatch&&row.status==='open'?form('assurance.approve',back,h`${hidden('case',row.id)}${hidden('basis',live.basis)}`,'Confirm exact agreement'):''}
        ${investigator?form('assurance.recheck',back,hidden('case',row.id),'Recheck case',{secondary:true}):''}
      </section>`
    })}`,{current:'/app/import',url})
}
