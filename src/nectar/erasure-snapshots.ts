// Shared report/run snapshots keep other customers and their numeric totals.
// The selected customer's structured free text is withdrawn recursively.
const structural = new Set(['id','customer','customerId','subscription','subscriptionId','invoice','invoiceId','sourceId','lineId','paymentId','period','periodStart','periodEnd','start','end','date','issueDate','dueDate','currency','kind','status','metric','version','quantity','unitAmount','unit_amount','href','path'])
export function redactShared(value: unknown, ids: Set<string>, personal: string[], owned = false, key = ''): unknown {
  if (typeof value === 'string') {
    if (ids.has(value)) return value
    if (personal.includes(value)) return '[erased]'
    if (owned && !structural.has(key)) return ''
    return personal.includes(value) ? '[erased]' : value
  }
  if (Array.isArray(value)) return value.map(v => redactShared(v,ids,personal,owned,key))
  if (value && typeof value === 'object') {
    const entries=Object.entries(value)
    const selected=owned||entries.some(([k,v])=>['id','customer','customer_id','customerId','subscription','subscription_id','subscriptionId','invoice','invoice_id','invoiceId','sourceId','paymentId','record_id'].includes(k)&&typeof v==='string'&&ids.has(v))
    return Object.fromEntries(entries.map(([k,v])=>[k,redactShared(v,ids,personal,selected,k)]))
  }
  return value
}
export function redactSnapshotCsv(text:string,personal:string[]) {
  const rows:string[][]=[];let row:string[]=[],cell='',quoted=false
  for(let i=0;i<text.length;i++){
    const char=text[i]
    if(char==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++}else quoted=!quoted}
    else if(!quoted&&(char===','||char==='\n')){row.push(cell);cell='';if(char==='\n'){rows.push(row);row=[]}}
    else if(!quoted&&char==='\r')continue
    else cell+=char
  }
  if(cell||row.length){row.push(cell);rows.push(row)}
  return rows.map(r=>r.map(c=>{const value=personal.includes(c)?'[erased]':c;return /[",\r\n]/.test(value)?`"${value.replaceAll('"','""')}"`:value}).join(',')).join('\r\n')+'\r\n'
}
