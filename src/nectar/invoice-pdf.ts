import { customerLineFacts } from './customer-invoice'
// Small PDF writer with byte-accurate offsets and separate text and image objects.
import { insist, type Row } from './core'
import { customerText } from './locale'
import { jpegSize } from './invoice-branding'

export function invoicePdf(data: Row): Uint8Array {
  const row=data.invoices[0], content=data.content, brand=content.branding,L=customerText(data.customer.language)
  const money=(cents:number)=>L.money(cents,row.currency??'USD')
  const rows=[row.number,data.merchant.legal_name,data.customer.name,
    `${L.t('portal.issued')}: ${L.day(row.issue_date)}`,`${L.t('portal.due')}: ${L.day(row.due_date)}`,
    content.paymentTermsDays?`${L.t('invoice.terms')}: Net ${content.paymentTermsDays}`:'',
    content.poNumber?`${L.t('invoice.po')}: ${content.poNumber}`:'',content.memo,
    ...Object.entries(content.customFields).map(([key,value])=>`${key}: ${value}`),brand.remitTo,
    L.t('portal.lines'),...data.lines.flatMap((line:Row)=>[`${line.description}: ${money(line.amount_cents)}`,...customerLineFacts(line,L,row.currency)]),
    `${L.t('portal.subtotal')}: ${money(row.subtotal_cents)}`,`${L.t('portal.tax')}: ${money(row.tax_cents)}`,`${L.t('portal.total')}: ${money(row.total_cents)}`,
    ...data.credits.map((credit:Row)=>`${credit.number}: ${money(credit.amount_cents)}`),
    ...data.payments.map((payment:Row)=>`${L.t('portal.payment')} ${L.day(payment.received_on)}: ${money(payment.amount_cents)}`),
    `${L.t('portal.credited')}: ${money(row.credited_cents)}`,`${L.t('portal.paid')}: ${money(row.paid_cents)}`,`${L.t('portal.owed')}: ${money(row.balance_cents)}`,brand.footer]
  const wrap=(line:string)=>{
    const wrapped:string[]=[];let current=''
    for(const word of line.split(/\s+/)){
      if(current&&current.length+word.length+1>86){wrapped.push(current);current=''}
      current+=(current?' ':'')+word
    }
    return [...wrapped,current]
  }
  const lines=rows.filter(Boolean).flatMap(value=>String(value).split(/\r?\n/).flatMap(wrap))
  const extra:Record<string,number>={'€':128,'‘':145,'’':146,'“':147,'”':148,'–':150,'—':151,'…':133,'™':153,'œ':156,'Œ':140,'Ÿ':159}
  const encode=(text:string)=>Array.from(text,c=>{const code=extra[c]??c.codePointAt(0)!;insist(code>=32&&code<=255,'invoice_pdf_character_unsupported',409);return code}).map(c=>c.toString(16).padStart(2,'0')).join('')
  const objects:string[]=[],add=(value:string)=>{objects.push(value);return objects.length}
  const catalog=add(''),pages=add(''),font=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  let image=0,dimensions={width:1,height:1}
  if(brand.logo){const bytes=Uint8Array.from(atob(brand.logo),c=>c.charCodeAt(0));dimensions=jpegSize(bytes);const binary=Array.from(bytes,b=>String.fromCharCode(b)).join('');image=add(`<< /Type /XObject /Subtype /Image /Width ${dimensions.width} /Height ${dimensions.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${binary.length} >>\nstream\n${binary}\nendstream`)}
  const color=brand.color.slice(1).match(/../g)!.map((c:string)=>(parseInt(c,16)/255).toFixed(4)).join(' '),kids=[]
  for(let start=0;start<lines.length;start+=42){
    const logo=image?`q 72 0 0 ${Math.min(60,72*dimensions.height/dimensions.width)} 480 732 cm /Logo Do Q\n`:''
    const text=lines.slice(start,start+42).map((line,index)=>`${index?'0 -16 Td ':''}<${encode(line)}> Tj`).join('\n')
    const stream=`${logo}BT /F1 11 Tf ${color} rg 48 720 Td\n${text}\nET`
    const contents=add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    kids.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> ${image?`/XObject << /Logo ${image} 0 R >>`:''} >> /Contents ${contents} 0 R >>`))
  }
  objects[catalog-1]=`<< /Type /Catalog /Pages ${pages} 0 R >>`;objects[pages-1]=`<< /Type /Pages /Kids [${kids.map(id=>`${id} 0 R`).join(' ')}] /Count ${kids.length} >>`
  let output='%PDF-1.4\n',offsets=[0]
  objects.forEach((object,index)=>{offsets.push(output.length);output+=`${index+1} 0 obj\n${object}\nendobj\n`})
  const xref=output.length;output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Uint8Array.from(output,c=>c.charCodeAt(0))
}
