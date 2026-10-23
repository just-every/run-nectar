import type { Bindings } from '../../auth.server'
import { type Actor } from '../actor'
import { currencyReport,dailyRates } from '../currency-rates'
import { NectarError } from '../core'
import { cents,details,field,form,h,page,select,table } from './html'

export async function currencyPage(env:Bindings,actor:Actor,url:URL){
  const rates=await dailyRates(env,actor)
  let report:Awaited<ReturnType<typeof currencyReport>>|null=null
  try{report=await currencyReport(env,actor,url)}catch(error){if(!(error instanceof NectarError)||error.code!=='daily_rate_required')throw error}
  return page('Currency reporting',actor,h`<h1>Currency reporting</h1><p>Invoices, payments and credits retain their billing currency. USD reporting uses the exact sourced daily rate for each transaction date, with one rounding per transaction. Missing rates leave the report unavailable.</p>
    <form method="get" action="/app/reports/currency">${field('From','from',{type:'date',value:url.searchParams.get('from')??'',required:false})}${field('To','to',{type:'date',value:url.searchParams.get('to')??'',required:false})}<button>Filter dates</button></form>
    <section class="card"><h2>USD report</h2>${report?h`${details(report.totals,'Totals in USD')}${table(['Kind','Source','Transaction amount','USD value','Rate','Rate date','Rate source'],report.transactions.map(row=>[row.kind,row.kind==='invoice'?h`<a href="/app/invoices/${row.id}">${row.number}</a>`:row.number??row.reference,cents(row.amount_cents,row.currency),cents(row.reporting.amountCents),row.reporting.rate,row.reporting.rateDate,row.reporting.source]))}`:h`<p>A sourced rate is required for a transaction date before this report can be calculated.</p>`}</section>
    <section class="card"><h2>Recorded daily rates</h2>${table(['Currency','Date','USD per unit','Source'],rates.map(row=>[row.currency,row.rate_date,row.usd_per_unit,row.source]),{empty:'No foreign-currency rates recorded.'})}
    ${actor.kind==='member'&&actor.role==='owner'?form('currency.rate.record',url.pathname+url.search,h`${select('Currency','currency',['CAD','EUR','GBP'].map(value=>({value,label:value})))}${field('Rate date','rate_date',{type:'date'})}${field('USD per currency unit','usd_per_unit')}${field('Rate source','source',{hint:'Record the actual source and quote date. A saved daily rate cannot be overwritten.'})}`,'Record sourced daily rate',{layout:'columns',secondary:true}):''}</section>`,{url,current:'/app/reports/billings'})
}
