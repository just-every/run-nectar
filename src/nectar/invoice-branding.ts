import { insist, parseJson, type Row } from './core'
import type { Input } from './input'

export interface InvoiceBranding { color: string; footer: string; remitTo: string; logo: string }

export function jpegSize(bytes: Uint8Array): {width:number;height:number} {
  insist(bytes[0]===255 && bytes[1]===216, 'invoice_logo_jpeg_required')
  for(let offset=2;offset+8<bytes.length;){
    insist(bytes[offset]===255, 'invalid_invoice_logo')
    const marker=bytes[offset+1], size=bytes[offset+2]*256+bytes[offset+3]
    if([192,193,194].includes(marker)){
      const height=bytes[offset+5]*256+bytes[offset+6], width=bytes[offset+7]*256+bytes[offset+8]
      insist(width>0&&height>0&&width<=4096&&height<=4096&&bytes[offset+9]===3, 'invoice_logo_rgb_required')
      return {width,height}
    }
    insist(size>=2, 'invalid_invoice_logo');offset+=size+2
  }
  insist(false, 'invalid_invoice_logo')
}
export function invoiceBranding(value: unknown): InvoiceBranding {
  insist(value&&typeof value==='object'&&!Array.isArray(value),'invalid_invoice_branding')
  const row=value as Row
  insist(Object.keys(row).every(key=>['color','footer','remitTo','logo'].includes(key)),'invalid_invoice_branding')
  const result={color:row.color??'#245c46',footer:row.footer??'',remitTo:row.remitTo??'',logo:row.logo??''}
  insist(typeof result.color==='string'&&/^#[0-9a-f]{6}$/i.test(result.color),'invalid_invoice_color')
  for(const key of ['footer','remitTo'] as const)insist(typeof result[key]==='string'&&result[key].length<=1000,'invalid_invoice_branding')
  insist(typeof result.logo==='string'&&result.logo.length<=133336&&result.logo.length%4===0&&/^[A-Za-z0-9+\/]*={0,2}$/.test(result.logo),'invalid_invoice_logo')
  if(result.logo)jpegSize(Uint8Array.from(atob(result.logo),c=>c.charCodeAt(0)))
  return result
}
export async function brandingInput(input: Input, saved='{}') {
  if(input.has('invoice_branding'))return invoiceBranding(input.json('invoice_branding'))
  const current=invoiceBranding(parseJson(saved,{}))
  if(!input.flag('invoice_branding_edit'))return current
  const file=await input.file('invoice_logo',{optional:true,maxBytes:100000})
  let logo=input.flag('invoice_logo_remove')?'':current.logo
  if(file){jpegSize(file.bytes);logo=btoa(Array.from(file.bytes,b=>String.fromCharCode(b)).join(''))}
  return invoiceBranding({color:input.text('invoice_color',{max:7}),footer:input.text('invoice_footer',{max:1000,optional:true}),remitTo:input.text('invoice_remit_to',{max:1000,optional:true}),logo})
}
