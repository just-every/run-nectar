// Run behind your HTTPS ingress. No provider-shaped fixtures or customer logs.
import { createServer } from 'node:http'
import { createHmac,timingSafeEqual } from 'node:crypto'
import { readFile,writeFile,rename } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
export function verify(body,header,secrets,at=Date.now()) {
  const parts=String(header??'').split(','),timestamp=parts.find(p=>p.startsWith('t='))?.slice(2)
  if(!/^\d+$/.test(timestamp??'')||Math.abs(at/1000-Number(timestamp))>300)return false
  const signatures=parts.filter(p=>/^v1=[0-9a-f]{64}$/.test(p)).map(p=>Buffer.from(p.slice(3),'hex'))
  return secrets.filter(Boolean).some(secret=>{
    const expected=createHmac('sha256',secret).update(`${timestamp}.${body}`).digest()
    return signatures.some(candidate=>timingSafeEqual(expected,candidate))
  })
}
// Serialize receipt persistence so simultaneous retries cannot apply an event
// twice. Replace the receipt body with your own transaction + unique event id.
export function receiver({ secrets, stateFile, clock=()=>Date.now(),onEvent=async()=>{} }) {
  let queue=Promise.resolve()
  return async request=>{
    const body=await request.text()
    if(Buffer.byteLength(body)>1000000)return new Response(null,{status:413})
    if(!verify(body,request.headers.get('nectar-signature'),secrets(),clock()))return new Response(null,{status:401})
    let event;try{event=JSON.parse(body)}catch{return new Response(null,{status:400})}
    if(typeof event.id!=='string'||typeof event.type!=='string')return new Response(null,{status:400})
    const work=queue.then(async()=>{
      let receipts={};try{receipts=JSON.parse(await readFile(stateFile,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
      if(Object.hasOwn(receipts,event.id))return
      // The sample records reception only; real side effects and the receipt
      // must be one application transaction.
      receipts[event.id]={type:event.type,received_at:clock()}
      await writeFile(stateFile+'.new',JSON.stringify(receipts),{mode:0o600});await rename(stateFile+'.new',stateFile)
      await onEvent(event)
    })
    queue=work.catch(()=>{})
    try{await work;return new Response(null,{status:204})}catch{return new Response(null,{status:503})}
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(!process.env.NECTAR_WEBHOOK_SECRET)throw new Error('Set NECTAR_WEBHOOK_SECRET in your secret manager')
  const receive=receiver({secrets:()=>[process.env.NECTAR_WEBHOOK_SECRET,process.env.NECTAR_WEBHOOK_PREVIOUS_SECRET],stateFile:process.env.NECTAR_RECEIPTS_FILE??'webhook-receipts.json'})
  createServer(async(req,res)=>{
    if(req.method!=='POST'||req.url!=='/webhooks'){res.writeHead(404).end();return}
    let size=0,chunks=[]
    for await(const chunk of req){size+=chunk.length;if(size>1000000){res.writeHead(413).end();return}chunks.push(chunk)}
    const result=await receive(new Request('http://localhost/webhooks',{method:'POST',headers:req.headers,body:Buffer.concat(chunks)}))
    res.writeHead(result.status).end()
  }).listen(9090,'127.0.0.1',()=>console.log('Receiver listening on loopback port 9090; expose /webhooks through your HTTPS ingress.'))
}
