// An actual archive keeps financial evidence while dropping executable consent.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join,relative } from 'node:path'
import { readArchive } from '@runeditrun/rer/modules/portability'
import { harness } from './harness.mjs'
import { command } from './cli.mjs'
import { prepaidRefundEdge } from './prepaid-refunds.mjs'
import { processorSetup } from './processor-events.mjs'
import { applyPolicy } from './policy-helper.mjs'
import { totp } from './mfa.mjs'

async function rows(path) {
  const bytes=await readFile(path),items=[]
  for await(const record of readArchive(new ReadableStream({start(controller){controller.enqueue(bytes);controller.close()}})))if(record.kind==='part')items.push(...record.items)
  return items.filter(item=>item.kind==='row')
}
export async function invoiceRefundArchivePhase(root,scratch,{persistence,databaseId}) {
  const file=name=>join(scratch,`invoice-refund-${name}.rer`),edge=prepaidRefundEdge(),date='2026-10-28',instant=`${date}T18:00:00Z`
  edge.at(instant)
  let h,settings,owner,factor
  const reopen=async()=>{
    h=await harness({persistence,databaseId,applyMigrations:false,settings,localTime:instant,stripeFetch:edge.fetch,stripeSecret:'synthetic-nectar-1'})
    owner=await h.signIn(h.vars.OWNER_EMAIL)
    if(factor)await h.api('mfa.verify',owner,{code:totp(factor,Date.parse(instant))})
  }
  const close=async()=>{settings={...h.vars};await h.close();h=null}
  const api=(path,body,status)=>h.api(path,owner,body,status)
  try {
    await command(root,['reset','--yes']);await command(root,['export','--output',file('empty')])
    const setup=await processorSetup(edge,{persistence,databaseId,applyMigrations:false,localTime:instant})
    h=setup.h;owner=setup.owner
    const ordinaryApi=h.api
    h.api=async(...args)=>{const result=await ordinaryApi(...args);if(args[0]==='mfa.totp.start')factor=result.secret;return result}
    await applyPolicy(h,owner,'credit.policy',{two_person_above:'1000'})
    const customer=(await api('customer.create',{external_id:'synthetic-nectar-refund-archive',name:'Synthetic archived refunds',billing_email:['synthetic-nectar-refund-archive','example.test'].join('@')})).id
    await api('collection.customer.bind',{customer,account_ref:'synthetic-nectar-native-account-1',stripe_customer_ref:'synthetic-nectar-native-customer-3',confirm:true})
    const paid=async()=>{
      const charge=(await api('charge.add',{customer,amount:'900',description:'Synthetic archive service',taxable:false,effective_date:date})).charge
      const invoice=await api('invoice.manual',{customer,charges:[charge],service_date:date})
      await api('invoice.approve',{invoice:invoice.id,acknowledge:true});await api('invoice.finalise',{invoice:invoice.id,issue_date:date})
      const pending=await api('collection.prepare',{invoice:invoice.id});await api('collection.confirm',pending.instructions.confirm)
      return invoice.id
    }
    const invoice=await paid(),pendingInvoice=await paid()
    await close();await command(root,['export','--output',file('before')]);await reopen()
    const input={invoice,amount:'900',destination:'original'},quote=await api('invoice.refund.preview',input)
    const completed=await api('invoice.refund.execute',{...input,basis:quote.basis,reason:'Synthetic archived completed refund',confirm:true})
    const pendingQuote=await api('invoice.refund.preview',{...input,invoice:pendingInvoice})
    const pending=await api('invoice.refund.prepare',{invoice:pendingInvoice,amount:'900',destination:'original',basis:pendingQuote.basis,reason:'Synthetic archived pending refund'})
    assert.equal(completed.status,'completed')
    const original=await api(`invoices/${invoice}`)
    await close();await command(root,['export','--output',file('populated')])
    const captured=await rows(file('populated'))
    assert.equal(captured.some(item=>item.table==='nc_invoice_refund_authority'),false)
    assert.equal(captured.filter(item=>item.table==='nc_invoice_refunds').length,2)
    await command(root,['reset','--yes']);await command(root,['import','--input',file('populated'),'--yes'])
    await command(root,['export','--output',file('restored')])
    const restored=await rows(file('restored'))
    const financial=items=>items.filter(item=>['nc_invoice_refunds','nc_credit_notes','nc_payments','nc_allocations'].includes(item.table)).map(({index,...row})=>row)
    assert.deepEqual(financial(restored),financial(captured))
    await reopen()
    const posts=()=>edge.calls.filter(call=>call.method==='POST').length,beforePosts=posts()
    assert.equal((await api('invoice.refund.reconcile',{refund:completed.id})).credit,completed.credit)
    assert.equal((await api('invoice.refund.execute',{refund:pending.id,basis:pending.basis,confirm:true},409)).error,'invoice_refund_authority_inactive')
    assert.deepEqual((await api(`invoices/${invoice}`)).lines,original.lines)
    assert.equal((await api(`reports/refunds?period=2026-10&customer=${customer}`)).totalCents,-90000)
    assert.equal(posts(),beforePosts)
    // A backup from before the cash write cannot create a new refund or credit.
    await close();await command(root,['reset','--yes']);await command(root,['import','--input',file('before'),'--yes']);await reopen()
    for(const destination of ['original','balance']) {
      const preview=await api('invoice.refund.preview',{invoice,amount:'900',destination})
      await api('invoice.refund.prepare',{invoice,amount:'900',destination,basis:preview.basis,reason:'Synthetic restored history refusal'},409)
    }
    assert.equal(posts(),beforePosts)
    assert.equal((await api(`customers/${customer}/balance`)).carriedCents,0)
    const request=await api('erasure.request',{customer})
    const link=h.mails.at(-1).text.match(/https?:\/\/[^\s"<]+\/erase\/[a-f0-9]{64}/)[0]
    assert.equal((await h.raw(new URL(link).pathname,{form:new URLSearchParams({confirm:'yes'})})).status,200)
    await api('erasure.approve',{request:request.id,confirm:true})
    await api('invoice.refund.preview',input,404)
    await close();await command(root,['export','--output',file('erased')])
    await command(root,['reset','--yes'])
    const refused=await command(root,['import','--input',file('before'),'--journal',relative(root,file('erased')),'--yes'],{refuse:true})
    assert.match(refused,/later_journal|erased_row|erasure_epoch/)
    await command(root,['import','--input',file('erased'),'--yes']);await reopen()
    await api('invoice.refund.preview',input,404)
    assert.equal(posts(),beforePosts)
    console.log('INV-005 archive: exact financial restore, inactive pending consent, stale-history money refusal and erasure replay refusal passed')
  } finally {await h?.close()}
}
