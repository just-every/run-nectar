import type { Bindings } from '../auth.server'
import { winbackForToken, acceptWinback } from './retention-winback'
import { h,page } from './ui/html'
import { NectarError,parseJson, type Row } from './core'
export async function retentionPublic(request:Request,env:Bindings):Promise<Response|null> {
  const url=new URL(request.url);if(!url.pathname.startsWith('/return/'))return null
  const reply=(title:string,body:ReturnType<typeof h>,status=200)=>page(title,null,body,{showNav:false,status})
  if(!['GET','HEAD','POST'].includes(request.method))return new Response(null,{status:405,headers:{allow:'GET, HEAD, POST'}})
  if(request.method==='POST'&&request.headers.get('origin')!==env.AUTH_ORIGIN){await request.arrayBuffer();return reply('Forbidden',h`<h1>Forbidden</h1>`,403)}
  const offer=await winbackForToken(env,url.pathname.split('/').at(-1)??'')
  if(!offer){if(request.body)await request.arrayBuffer();return reply('Offer unavailable',h`<h1>This return offer is no longer available</h1><p>It may have expired or already been used. Contact the business for your subscription status.</p>`,404)}
  const terms=parseJson<Row>(offer.terms_json,{})
  if(request.method==='POST') {
    const form=await request.formData();if(form.get('confirm')!=='accept')return reply('Confirmation required',h`<h1>Confirm your return</h1>`,400)
    try{const accepted=await acceptWinback(env,offer);return reply('Subscription resumed',h`<h1>Subscription resumed</h1><p>Your service resumes ${accepted.day}. ${accepted.percent}% off fixed and seat charges applies for monthly periods from ${accepted.from} until ${accepted.to}, exclusive. Usage is billed at its ordinary rate. No further step is required.</p>`)}catch(error){if(!(error instanceof NectarError))throw error;return reply('Offer changed',h`<h1>The subscription changed</h1><p>Ask the business for a fresh offer. No change was applied.</p>`,error instanceof Error&&'status' in error?Number(error.status):409)}
  }
  return reply('Your return offer',h`<h1>Your return offer</h1><section class="card"><p>Resume this subscription with ${terms.percent}% off fixed and seat charges for ${terms.months} monthly periods, including the current open period. Usage is excluded. The discount ends automatically.</p><p>Expires ${offer.to_date}. Your service resumes when you accept; inactive days are not billed.</p><form method="post" action="${url.pathname}"><input type="hidden" name="confirm" value="accept"><button type="submit">Accept and resume</button></form></section>`)
}
