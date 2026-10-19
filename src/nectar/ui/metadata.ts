import type { Bindings } from '../../auth.server'
import { can,type Actor } from '../actor'
import { metadataView } from '../metadata'
import { metadataObjects } from '../metadata-lists'
import { METADATA_KINDS } from '../metadata-records'
import { area,details,field,form,h,hidden,page,select,table,who } from './html'

export const metadataLink=(kind:string,id:string)=>h`<a href="/app/metadata/${kind}/${id}">Metadata</a>`

export async function metadataPage(env:Bindings,actor:Actor,kind:string,record:string,url:URL) {
 const m=await metadataView(env,actor,kind,record)
 return page('Metadata',actor,h`<p class="crumbs"><a href="${m.href}">Back to ${m.label}</a> · <a href="/app/metadata?kind=${kind}">Browse metadata</a></p><h1>Metadata</h1>
 <section class="card"><h2>${m.label}</h2><p class="hint">Metadata adds context without changing the original record or its billing calculation. Every replacement keeps the earlier revision.</p>
 ${table(['Key','Value'],Object.entries(m.metadata),{empty:'No metadata recorded.'})}
 ${actor.kind==='member'&&can(actor,'records')?form('metadata.write',`/app/metadata/${kind}/${record}`,h`${hidden('kind',kind)}${hidden('record',record)}${hidden('revision',m.revision)}${area('Key-value pairs (JSON object of strings)','metadata',JSON.stringify(m.metadata,null,2),true,8)}<p class="hint">Replace up to 50 key-value pairs. Keys and string values are kept exactly; use an empty object to clear the current metadata.</p>`,'Save metadata'):''}</section>
 <section class="card"><h2>Revision history</h2>${table(['Revision','Author','Recorded','Values'],m.history.map(r=>[r.revision,who(actor,r.author),new Date(r.created_at).toISOString(),details(r.metadata)]),{empty:'No metadata revisions yet.'})}</section>`,{url})
}

export async function metadataListPage(env:Bindings,actor:Actor,url:URL) {
 const kind=url.searchParams.get('kind')??'customer',{data}=await metadataObjects(env,actor,kind,url)
 const download=new URL(`/app/exports/objects/${kind}.csv`,url.origin);download.search=url.search
 return page('Object metadata',actor,h`<h1>Object metadata</h1><section class="card"><form method="get" action="/app/metadata" class="row-form">${select('Record kind','kind',METADATA_KINDS.map(k=>({value:k,label:k})),kind)}${field('Metadata key','metadata_key',{value:url.searchParams.get('metadata_key')??'',required:false})}${field('Exact value','metadata_value',{value:url.searchParams.get('metadata_value')??'',required:false})}<button type="submit">Filter metadata</button><a href="/app/metadata?kind=${kind}">Clear filter</a></form>
 <p class="hint">Filters compare the exact key and string value on the current revision. Use Clear filter to list all records.</p>
 ${can(actor,'export')?h`<p><a href="${download.pathname+download.search}">Download metadata CSV</a></p>`:''}
 ${table(['Record','Revision','Metadata'],data.map(r=>[h`<a href="/app/metadata/${kind}/${r.id}">${r.label}</a>`,r.metadata_revision,details(r.metadata)]),{empty:'No matching records.'})}</section>`,{current:'/app/exports',url})
}
