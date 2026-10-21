import type { Bindings } from '../auth.server'
import { winbackForToken, acceptWinback } from './retention-winback'
import { h,page } from './ui/html'
import { NectarError,one,parseJson, type Row } from './core'
import { customerText } from './locale'
export async function retentionPublic(request:Request,env:Bindings):Promise<Response|null> {
  const url=new URL(request.url);if(!url.pathname.startsWith('/return/'))return null
  // Until a live token names the customer, the page is in the default language.
  let L=customerText(null)
  const reply=(title:string,body:ReturnType<typeof h>,status=200)=>page(title,null,body,{showNav:false,status,lang:L.tag})
  if(!['GET','HEAD','POST'].includes(request.method))return new Response(null,{status:405,headers:{allow:'GET, HEAD, POST'}})
  if(request.method==='POST'&&request.headers.get('origin')!==env.AUTH_ORIGIN){await request.arrayBuffer();return reply(L.t('public.forbidden'),h`<h1>${L.t('public.forbidden')}</h1>`,403)}
  const offer=await winbackForToken(env,url.pathname.split('/').at(-1)??'')
  if(!offer){if(request.body)await request.arrayBuffer();return reply(L.t('return.unavailable.title'),h`<h1>${L.t('return.unavailable.heading')}</h1><p>${L.t('return.unavailable.body')}</p>`,404)}
  L=customerText((await one(env,'SELECT c.language FROM nc_subscriptions s JOIN nc_customers c ON c.id=s.customer_id WHERE s.id=?',offer.subscription_id))?.language)
  const terms=parseJson<Row>(offer.terms_json,{})
  if(request.method==='POST') {
    const form=await request.formData();if(form.get('confirm')!=='accept')return reply(L.t('renewal.confirm.title'),h`<h1>${L.t('return.confirm')}</h1>`,400)
    try{const accepted=await acceptWinback(env,offer);return reply(L.t('return.resumed.title'),h`<h1>${L.t('return.resumed.title')}</h1><p>${L.t('return.resumed.body',{day:L.day(accepted.day),percent:L.percent(accepted.percent),from:L.day(accepted.from),to:L.day(accepted.to)})}</p>`)}catch(error){if(!(error instanceof NectarError))throw error;return reply(L.t('renewal.changed.title'),h`<h1>${L.t('return.changed.heading')}</h1><p>${L.t('return.changed.body')}</p>`,error instanceof Error&&'status' in error?Number(error.status):409)}
  }
  return reply(L.t('return.offer.title'),h`<h1>${L.t('return.offer.title')}</h1><section class="card"><p>${L.t(terms.billing?'return.offer.body_periods':'return.offer.body',{percent:L.percent(terms.percent),months:terms.months})}</p><p>${L.t('return.offer.expires',{date:L.day(offer.to_date)})}</p><form method="post" action="${url.pathname}"><input type="hidden" name="confirm" value="accept"><button type="submit">${L.t('return.offer.accept')}</button></form></section>`)
}
