import type { Bindings } from '../../auth.server'
import type { Actor } from '../actor'
import { languages } from '../locale'
import { canReadPrepaidRefundPrivate } from '../prepaid-refund-access'
import { refundNoticeSettings } from '../prepaid-refund-mail'
import { area, details, field, form, h, hidden, select } from './html'

export async function prepaidRefundMailSection(env:Bindings,actor:Actor,back='/app/settings'){
  if(!await canReadPrepaidRefundPrivate(env,actor))return ''
  const state=await refundNoticeSettings(env,actor)
  const options=[{value:'off',label:'Off'},{value:'nectar',label:'Nectar'},{value:'processor',label:'Processor (Nectar stays off)'}]
  return h`<section class="card"><h2>Prepaid refund notices</h2><p>Default: off until the owner records a sender. Refunded and failed outcomes have independent switches. Choose Processor when its own customer email is enabled. Each outcome reserves one notice; an uncertain or failed send is never retried. Acceptance records provider acceptance, not mailbox delivery.</p>
    <p>Every body must retain {amount}, {units}, {purchase} and {credit}. Those placeholders use the actual refund facts. Failed refunds state that no numbered credit was issued. Write each language exactly as it should be sent; authored wording is preserved.</p>
    ${actor.role==='owner'?languages().map(({value:language,label})=>form('prepaid.refund.notice.configure',back,h`
      <h3>${label}</h3>${hidden('language',language)}${hidden('revision',state.revision)}
      ${select('Refunded notice sender','refunded_sender',options,state.refundedSender)}
      ${field('Refunded subject','refunded_subject',{value:state.templates[language].refunded.subject})}
      ${area('Refunded body','refunded_body',state.templates[language].refunded.body)}
      ${select('Failed notice sender','failed_sender',options,state.failedSender)}
      ${field('Failed subject','failed_subject',{value:state.templates[language].failed.subject})}
      ${area('Failed body','failed_body',state.templates[language].failed.body)}`,'Save refund notice settings',{secondary:true})):''}
    ${details({refundedSender:state.refundedSender,failedSender:state.failedSender,configuredBy:state.configuredBy,configuredAt:state.configuredAt},'Recorded owner configuration')}
    ${details({deliveries:state.deliveries},'Private notice delivery log')}</section>`
}
