import assert from 'node:assert/strict'

// PORT-005 / AGENT-002: the same live customer session sees only committed
// human decisions. Compare exact saved preview figures through both doors.
export async function portalCorrections(h, owner, session, invoiceId) {
  const api=(path,body,status)=>h.api(path,owner,body,status)
  const read=async()=>await (await h.raw(`/portal/data?session=${session.token}`)).json()
  const before=await read(),original=await api(`invoices/${invoiceId}`)
  const line=original.lines[0]
  const payload={invoice_credit:true,invoice:invoiceId,amount:'10',reason:'Reviewed platform adjustment',explanation:'The reviewed platform adjustment credits USD 10.00.',subject:'Platform adjustment',body:'A USD 10.00 credit reduces the balance from USD 175.00 to USD 165.00; the original USD 300.00 invoice and USD 0.00 tax stay unchanged.',citations:[{line_id:line.id,source:`/app/invoices/${invoiceId}/lines/${line.id}`,quote:line.description}]}
  const prepared=await api('proposal.create',{kind:'amendment',title:'Portal correction',payload})
  const proposal=await api(`proposals/${prepared.id}`)
  assert.equal(proposal.impact.credit.amountCents,1000,'PORT-005 correction preview credit is exact')
  assert.equal(proposal.impact.credit.balanceAfterCents,16500,'PORT-005 correction preview balance is exact')
  assert.deepEqual(await read(),before,'PORT-005 preparing a correction changes no customer figures')
  await api('proposal.decide',{proposal:prepared.id,decision:'approved'})
  const after=await read(),row=after.invoices.find(row=>row.id===invoiceId)
  assert.deepEqual([row.total_cents,row.tax_cents,row.credited_cents,row.paid_cents,row.balance_cents],[30000,0,3500,10000,16500],'PORT-005 portal original/credit/payment/owed figures equal the approved correction')
  assert.equal(row.balance_cents,proposal.impact.credit.balanceAfterCents)
  const detail=await (await h.raw(`/portal/invoices/${invoiceId}?session=${session.token}`)).text()
  for(const amount of ['USD 300.00','USD 35.00','USD 100.00','USD 165.00','USD 10.00'])assert.ok(detail.includes(amount),`PORT-005 correction shows ${amount}`)
  assert.match(detail,/Reviewed platform adjustment/)
  const now=await api(`invoices/${invoiceId}`)
  for(const key of ['calculation','lines','subtotal_cents','tax_cents','total_cents','source_fingerprint'])assert.deepEqual(now[key],original[key],'PORT-005 credit leaves original issued evidence unchanged')
  await api('proposal.decide',{proposal:prepared.id,decision:'approved'},409)
  assert.deepEqual(await read(),after,'PORT-005 duplicate approval cannot change portal figures')
  const rejected=await api('proposal.create',{kind:'amendment',title:'Rejected portal correction',payload:{...payload,body:'A second adjustment is proposed for review.'}})
  await api('proposal.decide',{proposal:rejected.id,decision:'rejected'})
  assert.deepEqual(await read(),after,'PORT-005 rejected correction changes no customer records')
}
