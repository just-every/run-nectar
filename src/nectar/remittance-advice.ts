// A supplied message is evidence, not sender authentication. Only its single
// CSV attachment may propose allocations against independently observed funds.
import { insist } from './core'
import { remittanceSources } from './remittance-matching'
export function remittanceAdvice(filename: string, bytes: Uint8Array) {
  if (!filename.toLowerCase().endsWith('.eml')) return remittanceSources(bytes)
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n') }
  catch { insist(false, 'remittance_invalid_encoding') }
  const split = text.indexOf('\n\n')
  insist(split >= 0, 'remittance_email_invalid')
  const headers = text.slice(0, split).replace(/\n[ \t]+/g, ' ')
  const content = headers.split('\n').find(line => /^content-type:/i.test(line)) ?? ''
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(content)
  insist(/^content-type:\s*multipart\/mixed\b/i.test(content) && boundary, 'remittance_email_attachment_required')
  const parts = text.slice(split + 2).split('--' + (boundary[1] ?? boundary[2])).slice(1)
  const attachments: Uint8Array[] = []
  for (const part of parts) {
    if (part.startsWith('--')) break
    const at = part.indexOf('\n\n')
    if (at < 0) continue
    const head = part.slice(0, at).replace(/\n[ \t]+/g, ' ')
    if (!/^content-type:\s*text\/csv\b/im.test(head)) continue
    insist(/^content-transfer-encoding:\s*base64\s*$/im.test(head), 'remittance_email_encoding')
    try {
      const body = atob(part.slice(at + 2).trim().replace(/\s/g, ''))
      attachments.push(Uint8Array.from(body, char => char.charCodeAt(0)))
    } catch { insist(false, 'remittance_email_encoding') }
  }
  insist(attachments.length === 1, 'remittance_email_attachment_required')
  return remittanceSources(attachments[0])
}
