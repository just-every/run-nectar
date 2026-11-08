// PORT-005 / AGENT-007: signed customers use the same ten-topic evaluator,
// but every cited operand resolves through a customer-scoped public door.
import assert from 'node:assert/strict'
import { applyPolicy } from './policy-helper.mjs'
import { seedAnswerRecords } from './billing-answers.mjs'

const pointer=(record,path)=>path.split('/').slice(1).reduce((value,key)=>value?.[key.replaceAll('~1','/').replaceAll('~0','~')],record)

export async function portalAnswersFlow(h,owner,onState=async()=>{}, suppliedFixture) {
  const fixture=suppliedFixture??await seedAnswerRecords(h,owner),{customer,otherCustomer,invoice,otherInvoice,previous}=fixture
  await h.api('portal.configure',owner,{hosts:[h.origin],parents:[h.origin]})
  const issue=async customer=>h.api('portal.session.issue',owner,{customer,origin:h.origin,audience:'hosted'})
  const session=await issue(customer),foreign=await issue(otherCustomer)
  const read=async (fields,token=session.token,status=200)=>{
    const response=await h.raw(`/portal/answer?${new URLSearchParams({session:token,invoice,question:'What is the total?',...fields})}`)
    assert.equal(response.status,status,'PORT-005 customer answer status')
    return response.status===200?await response.json():await response.text()
  }
  const current=await h.api(`invoices/${invoice}`,owner),prior=await h.api(`invoices/${previous}`,owner)
  assert.deepEqual([prior.total_cents,current.total_cents,current.balanceCents],[14080,40370,37370],'PORT-005 independent invoice and commitment arithmetic')
  const before={audit:await h.api('audit',owner),proposals:await h.api('proposals',owner),invoice:current,mail:h.mails.length}
  const questions=[
    ['What is the total on this invoice?','total'],['Why is this invoice higher than the previous invoice?','comparison'],
    ['How many seats were billed?','seats'],['What usage was billed?','usage'],['Which events are behind the usage charge?','events'],
    ['How was sales tax calculated?','tax'],['Which discounts and contract credits affected this bill?','adjustments'],
    ['Why did the minimum commitment need a true-up?','commitment'],['What do we owe after payments and credit notes?','balance'],
    ['What saved billing terms were used?','terms'],
  ]
  const answers=[]
  for(const [question,topic] of questions){
    const answer=await read({question});answers.push(answer)
    assert.equal(answer.topic,topic,'PORT-005 honest topic interpretation')
    assert.equal(answer.customerId,customer);assert.equal(answer.invoiceId,invoice)
    for(const figure of [...answer.figures,...(answer.comparison?.lineDeltas??[]).flatMap(line=>[...line.before,...line.after])]){
      assert.ok(figure.source.startsWith('/portal/evidence/invoices/'),'PORT-005 customer citations never grant operator access')
      const response=await h.raw(`${figure.source}?session=${session.token}`)
      assert.equal(response.status,200,'PORT-005 customer source is reachable')
      const source=await response.json()
      assert.deepEqual(pointer(source,figure.recordPath),figure.value,'PORT-005 exact typed figure resolves to its saved customer source')
      assert.doesNotMatch(JSON.stringify(source),/CEDAR-CHK-20|Bank receipt|ap@cedar|created_by|basis_json|metadata|creditPolicy|billing_email|note|clause/,'PORT-005 sources exclude operator custody')
    }
    for(const citation of answer.citations)assert.equal((await h.raw(`${citation.href}?session=${session.token}`)).status,200,'PORT-005 own invoice citation reachable')
    assert.doesNotMatch(JSON.stringify(answer),/\/app\/|\/api\/nectar\//,'PORT-005 no operator citation URL')
    await onState({session,invoice,question,topic,answer})
  }
  assert.deepEqual(answers[0].figures.map(f=>f.value),[36700,3670,40370])
  assert.equal(answers[1].comparison.totalDeltaCents,26290)
  assert.equal(answers[1].comparison.lineDeltas.reduce((n,line)=>n+line.deltaCents,0),23900)
  assert.ok(answers[4].figures.some(f=>typeof f.value==='string'&&f.value.replace(/\.0+$/,'')==='200'),'PORT-005 original event quantity is cited: '+JSON.stringify(answers[4]))
  assert.ok(answers[8].figures.some(f=>f.value===37370),'PORT-005 actual credit/payment balance')
  assert.equal((await read({invoice:otherInvoice},foreign.token)).customerId,otherCustomer,'PORT-005 distinct customer receives own independent answer')
  for(const fields of [{invoice:otherInvoice},{topic:'comparison',comparison_invoice:otherInvoice},{question:'What is the total for Maple Research?'},{customer:otherCustomer},{credit_amount:'10'},{topic:'bank'},{question:'What is the upcoming invoice?'},{question:'What is the refund?',topic:'total'}])await read(fields,session.token,[otherInvoice].includes(fields.invoice)||fields.comparison_invoice||fields.question?.includes('Maple')?404:400)
  const ownLine=current.lines[0].id,otherLine=(await h.api(`invoices/${otherInvoice}`,owner)).lines[0].id
  for(const path of [`/portal/evidence/invoices/${otherInvoice}`,`/portal/evidence/invoices/${otherInvoice}/lines/${otherLine}`,`/portal/evidence/invoices/${invoice}/lines/${otherLine}`])assert.equal((await h.raw(`${path}?session=${session.token}`)).status,404,'PORT-005 foreign evidence denied')
  const ownSource=await (await h.raw(`/portal/evidence/invoices/${invoice}?session=${session.token}`)).json()
  assert.equal(ownSource.lines[0].id,ownLine)
  for(const path of ['/portal/answers','/portal/answer',`/portal/evidence/invoices/${invoice}`])assert.equal((await h.raw(path,{cookie:owner})).status,401,'PORT-005 operator session cannot read customer answers')
  assert.deepEqual(await h.api('audit',owner),before.audit,'PORT-005 answers and citations are write-free')
  assert.deepEqual(await h.api('proposals',owner),before.proposals,'PORT-005 no implicit credit proposal')
  assert.deepEqual(await h.api(`invoices/${invoice}`,owner),before.invoice)
  assert.equal(h.mails.length,before.mail,'PORT-005 reading never sends')
  const requestCredit=async(fields={},options={})=>h.raw(`/portal/answer-proposal?session=${session.token}`,{body:{invoice,question:'What do we owe?',credit_amount:'10',reason:'Please review a duplicated charge',...fields},...options})
  const untouched=await h.api(`invoices/${invoice}`,owner)
  for(const [fields,options,status] of [[{}, {headers:{origin:'https://foreign.example'}},403],[{invoice:otherInvoice},{},404],[{customer:otherCustomer},{},400],[{recipient:'elsewhere@example.test'},{},400],[{credit_amount:'99999'},{},409]])assert.equal((await requestCredit(fields,options)).status,status,'PORT-005 customer proposal refuses scope/origin/balance overrides')
  const requested=await requestCredit();assert.equal(requested.status,200,'PORT-005 pending proposal: '+(requested.status!==200?await requested.text():''))
  const pending=await requested.json(),prepared=await h.api(`proposals/${pending.id}`,owner)
  assert.equal(prepared.status,'pending');assert.equal(prepared.created_by_kind,'customer','PORT-005 customer never represented as an operator or agent')
  assert.equal(prepared.created_by,`customer:portal:${customer}`)
  assert.equal(prepared.payload.invoice,invoice)
  assert.equal(prepared.impact.credit.balanceAfterCents,36370)
  assert.deepEqual(await h.api(`invoices/${invoice}`,owner),untouched,'PORT-005 explicit request changes no money')
  assert.equal((await h.raw(`/portal/proposals/${pending.id}?session=${foreign.token}`)).status,404,'PORT-005 foreign pending proposal refused')
  for(const action of ['approve','decide','credit.issue'])assert.equal((await h.raw(`/portal/${action}?session=${session.token}`,{body:{proposal:pending.id}})).status,405,'PORT-005 customer has no approval door')
  await h.api('proposal.decide',owner,{proposal:pending.id,decision:'approved'})
  const accepted=await h.api(`invoices/${invoice}`,owner)
  assert.equal(accepted.balanceCents,prepared.impact.credit.balanceAfterCents,'PORT-005 human approval executes ordinary source-bound proposal')
  assert.deepEqual(accepted.calculation,current.calculation,'PORT-005 proposal approval leaves issued calculation unchanged')
  assert.match(await(await h.raw(`/portal/proposals/${pending.id}?session=${session.token}`)).text(),/Approved by the business/)
  const second=await(await requestCredit()).json()
  await h.api('proposal.decide',owner,{proposal:second.id,decision:'rejected'})
  assert.equal((await h.api(`invoices/${invoice}`,owner)).balanceCents,accepted.balanceCents,'PORT-005 rejection changes no money')
  await h.api('customer.update',owner,{customer,revision:(await h.api(`customers/${customer}`,owner)).revision,external_id:'CEDAR-ANS',name:'Cedar Analytics',billing_email:'ap@cedar.example',language:'es-US'})
  const spanish=await read({topic:'total'})
  assert.deepEqual(spanish.figures.map(f=>f.value),answers[0].figures.map(f=>f.value),'PORT-005 Spanish exact figures')
  assert.match(spanish.summary,/Total original/)
  await onState({session,invoice,question:'total',topic:'spanish',answer:spanish})
  const spanishQuestions=['¿Cuál es el total de esta factura?','¿Por qué esta factura es más alta que la anterior?','¿Cuántos puestos se facturaron?','¿Qué uso se ha facturado?','¿Qué eventos justifican el uso?','¿Cómo se calculó el impuesto?','¿Qué descuentos y créditos afectaron esta factura?','¿Por qué hubo una regularización del compromiso mínimo?','¿Cuál es el saldo pendiente después de pagos y créditos?','¿Qué condiciones y fechas de servicio se usaron?']
  for(const [index,question] of spanishQuestions.entries()){
    const answer=await read({question})
    assert.equal(answer.topic,questions[index][1],'PORT-005 Spanish question interprets the same supported billing topic')
    const english=await h.api('answer.read',owner,{customer,invoice,question:questions[index][0]})
    assert.deepEqual(answer.figures.map(f=>[f.value,f.unit,f.recordPath]),english.figures.filter(f=>f.unit!=='property').map(f=>[f.value,f.unit,f.recordPath]),'PORT-005 Spanish answer retains the exact English source operands')
  }
  await read({question:'¿Cuál es el total de Maple Research?'},session.token,404)
  const unsupported=await h.raw(`/portal/answer?${new URLSearchParams({session:session.token,invoice,question:'¿Qué reembolso recibiré?'})}`)
  assert.equal(unsupported.status,400)
  assert.match(await unsupported.text(),/lang="es-US"/,'PORT-005 an authenticated Spanish refusal retains the customer language')
  const spanishRequest=await(await requestCredit()).json()
  const spanishProposal=await h.api(`proposals/${spanishRequest.id}`,owner)
  assert.match(spanishProposal.payload.body,/Un crédito solicitado/,'PORT-005 requested credit explanation follows the customer language')
  await h.api('proposal.decide',owner,{proposal:spanishRequest.id,decision:'rejected'})
  await applyPolicy(h,owner,'credit.policy',{two_person_above:'5'})
  const governed=await(await requestCredit()).json()
  await h.api('proposal.decide',owner,{proposal:governed.id,decision:'approved'},409)
  const binding=await h.api('proposal.credit.prepare',owner,{proposal:governed.id})
  await h.api('credit.approve',fixture.finance,{request:binding.request},409)
  await h.api('proposal.decide',owner,{proposal:governed.id,decision:'approved'},409)
  await h.api('proposal.decide',fixture.finance,{proposal:governed.id,decision:'approved'})
  assert.equal((await h.api(`invoices/${invoice}`,owner)).balanceCents,35370,'PORT-005 above-limit customer proposal requires distinct human approval')
  const stale=await(await requestCredit()).json()
  await h.api('customer.update',owner,{customer,revision:(await h.api(`customers/${customer}`,owner)).revision,name:'Cedar Analytics',billing_email:'replacement@cedar.example',language:'es-US'})
  await h.api('proposal.decide',owner,{proposal:stale.id,decision:'approved'},409)
  await h.api('portal.session.revoke',owner,{session:session.id})
  await read({},session.token,401)
  console.log('PORT-005 ten customer answer topics, exact safe citations, isolation, language and write-free reads passed')
}
