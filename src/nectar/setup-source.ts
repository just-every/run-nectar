import { insist, sha256Hex, type Row } from './core'
import { Input } from './input'

export function object(value: unknown, field: string): Row {
  insist(value && typeof value === 'object' && !Array.isArray(value), `invalid_${field}`)
  return value as Row
}
export function rows(value: unknown, field: string, max = 120): Row[] {
  if (value === undefined) return []
  insist(Array.isArray(value) && value.length <= max, `invalid_${field}`)
  return value.map(v => object(v, field))
}
export function quoted(source: Row, row: Row, field: string, quotes: Row[]) {
  insist(typeof row.quote === 'string' && row.quote.trim().length > 0 && row.quote.length <= 10000 && source.text.includes(row.quote), 'setup_quote_not_in_source', 400, { field })
  quotes.push({ field, quote: row.quote })
}
export function fields(row: Row, allowed: string[]) {
  insist(Object.keys(row).every(k => allowed.includes(k)), 'unexpected_setup_field', 400, { fields: Object.keys(row).filter(k => !allowed.includes(k)) })
}
export function flag(row: Row, key: string, fallback = false) {
  insist(row[key] === undefined || typeof row[key] === 'boolean', `invalid_${key}`)
  return row[key] ?? fallback
}
export async function setupSource(payload: Row) {
  const row = object(payload.source, 'setup_source')
  fields(row, ['name', 'text', 'execution_reference', 'original'])
  const input = Input.of(row)
  const name = input.text('name', { max: 200 })
  insist(!/[\\/\x00-\x1f]/.test(name), 'invalid_source_name')
  // Hash the original bytes of text, including whitespace; never claim to verify a signature.
  insist(typeof row.text === 'string' && row.text.trim() && row.text.length <= 500000, 'invalid_source_text')
  if(row.original && typeof row.original.base64==='string' && /^[A-Za-z0-9+/]*={0,2}$/.test(row.original.base64)) {
    const encoded=row.original.base64,padding=encoded.endsWith('==')?2:encoded.endsWith('=')?1:0
    insist(Math.floor(encoded.length*3/4)-padding<=256000,'setup_original_exceeds_256000_bytes_use_text_only_source',400,{textOnlyAllowed:true,message:'Original files are limited to 256,000 bytes in this installation. Submit the exact executed text without original, or use a smaller original.'})
  }
  const original=await input.file('original',{optional:true,maxBytes:256000})
  return { ...(original?{original:{filename:original.filename,type:original.declaredType,base64:row.original.base64,sha256:await sha256Hex(original.bytes),byteLength:original.bytes.length}}:{}),name, text: row.text, execution_reference: input.text('execution_reference', { max: 1000 }), sha256: await sha256Hex(row.text) }
}
export function setupAmbiguities(payload: Row, source: Row, paymentTerms: number) {
  const manual = rows(payload.ambiguities, 'ambiguities').map(a => {
    fields(a, ['issue', 'resolution'])
    return { issue: Input.of(a).text('issue', { max: 2000 }), resolution: Input.of(a).text('resolution', { max: 2000, optional: true }) }
  })
  const ambiguities: Row[] = manual.filter(a => !a.resolution).map(a => ({ issue: a.issue }))
  const known = ['setup', 'source', 'customer', 'catalog', 'subscription', 'items', 'commitments', 'included', 'exceptions', 'usage_assumptions', 'usage_scenario_label', 'ambiguities', 'ramps', 'revises']
  for (const key of Object.keys(payload).filter(k => !known.includes(k))) ambiguities.push({ issue: `Unsupported setup field: ${key}` })
  const patterns: [RegExp, string][] = [
    [/\b(purchase order|PO number|P\.O\.)\b/i, 'Purchase-order custody and invoice requirements need an explicit supported resolution.'],
    [/\b(annually|quarterly|semi[- ]annually|annual billing|quarterly billing|in advance|prepay(?:ment|ments|able)?)\b/i, 'Nonmonthly or advance billing terms require review; this plan rates monthly in arrears.'],
    [/\b(multi[- ]entity|multiple entities|subsidiar(?:y|ies)|affiliate billing|bill[- ]to entit(?:y|ies))\b/i, 'Multiple billing entities require an explicit supported resolution.'],
  ]
  for (const [pattern, issue] of patterns) if (pattern.test(source.text)) ambiguities.push({ issue })
  if (/\bauto[- ]renew(?:al|ing|s)?\b/i.test(source.text) && /\b(annual|yearly|(?:twelve|12)[- ]month)\s+(term|contract|renewal)\b/i.test(source.text)) ambiguities.push({ issue: 'Annual auto-renewing contract terms need an explicit supported resolution; a finite initial term does not establish the renewal end date.' })
  if (/\b(due|payable) (on|upon) receipt\b/i.test(source.text) && paymentTerms !== 0) ambiguities.push({ issue: 'Order requires payment on receipt, different from business default terms.' })
  for (const match of source.text.matchAll(/\bnet\s+(\d{1,3})\b/gi)) if (Number(match[1]) !== paymentTerms) ambiguities.push({ issue: `Order payment terms ${match[0]} differ from business default Net ${paymentTerms}.` })
  return ambiguities
}
