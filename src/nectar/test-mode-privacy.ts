// Sandbox previews carry no legally retained financial document. Withdraw
// incidental personal text in labels while preserving pricing and calendars.
export function sandboxRedaction(value: unknown, personal: string[], key = ''): unknown {
  if (typeof value === 'string') return key === 'label' || key === 'description'
    ? personal.reduce((text, item) => item ? text.split(item).join('[erased]') : text, value) : value
  if (Array.isArray(value)) return value.map(item => sandboxRedaction(item, personal, key))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, sandboxRedaction(item, personal, field)]))
  return value
}
