// A synthetic QuickBooks Online company at the network edge: query and journal
// entry endpoints only, with request-id idempotency and injectable outages. It
// asserts what Nectar sends (balanced lines, a customer on the receivable line,
// the installation's bearer token) and records every created entry.
import assert from 'node:assert/strict'

export function quickbooksEdge({ company = 'synthetic-nectar-company', token = 'synthetic-nectar-qbo' } = {}) {
  const accounts = new Map([['Bad Debts', '80'], ['Accounts Receivable (A/R)', '84'], ['Billings Clearing', '90'], ['Contract Assets', '91'], ['Deferred Revenue', '92'], ['Revenue', '93']]), customers = new Map()
  const entries = [], byRequest = new Map(), calls = []
  let outage = null
  const unquote = text => text.replace(/\\(['\\])/g, '$1')
  const fetch = async request => {
    const url = new URL(request.url), path = url.pathname
    assert.equal(request.headers.get('authorization'), `Bearer ${token}`, 'only the installation-held token reaches the ledger edge')
    assert.ok(path.startsWith(`/v3/company/${company}/`), `posting goes to the recorded company: ${path}`)
    calls.push({ method: request.method, path: path.split('/').at(-1), query: url.searchParams.get('query') })
    if (outage === 'down') return new Response('{}', { status: 503 })
    if (outage === 'unauthorized') return new Response('{}', { status: 401 })
    if (request.method === 'GET' && path.endsWith('/query')) {
      const query = url.searchParams.get('query'), found = query.match(/^select Id, (\w+) from (\w+) where \w+ = '((?:[^'\\]|\\.)*)'$/)
      assert.ok(found, `understood query ${query}`)
      const [, , kind, value] = found, text = unquote(value)
      if (kind === 'JournalEntry') return Response.json({ QueryResponse: { JournalEntry: entries.filter(entry => entry.DocNumber === text).map(entry => ({ Id: entry.Id, DocNumber: entry.DocNumber })) } })
      if (kind === 'Account') return Response.json({ QueryResponse: { Account: accounts.has(text) ? [{ Id: accounts.get(text), Name: text }] : [] } })
      if (kind === 'Customer') return Response.json({ QueryResponse: { Customer: customers.has(text) ? [{ Id: customers.get(text), DisplayName: text }] : [] } })
      assert.fail(`unexpected query kind ${kind}`)
    }
    assert.equal(request.method, 'POST'); assert.ok(path.endsWith('/journalentry'))
    const requestId = url.searchParams.get('requestid'); assert.ok(requestId, 'every write carries its request id')
    if (byRequest.has(requestId)) return Response.json({ JournalEntry: byRequest.get(requestId) })
    const body = await request.json(), lines = body.Line
    const sum = side => lines.filter(line => line.JournalEntryLineDetail.PostingType === side).reduce((n, line) => n + Math.round(line.Amount * 100), 0)
    assert.ok(sum('Debit') > 0 && sum('Debit') === sum('Credit'), 'the journal entry balances')
    for (const line of lines) {
      assert.ok([...accounts.values()].includes(line.JournalEntryLineDetail.AccountRef.value))
      if (body.PrivateNote.includes('bad debt') && line.JournalEntryLineDetail.AccountRef.value === accounts.get('Accounts Receivable (A/R)')) assert.ok(line.JournalEntryLineDetail.Entity?.EntityRef?.value, 'the receivable line names its customer')
    }
    const entry = { Id: `synthetic-je-${entries.length + 1}`, DocNumber: body.DocNumber, TxnDate: body.TxnDate, PrivateNote: body.PrivateNote, Line: lines, requestId }
    entries.push(entry); byRequest.set(requestId, entry)
    if (outage === 'lost') return new Response('{}', { status: 500 })
    return Response.json({ JournalEntry: entry })
  }
  return { fetch, entries, calls, addCustomer: (name, id = `synthetic-customer-${customers.size + 1}`) => customers.set(name, id), setOutage: mode => { outage = mode },
    summary: () => entries.map(entry => entry.Line.map(line => `${line.JournalEntryLineDetail.PostingType[0]}:${line.JournalEntryLineDetail.AccountRef.value}:${line.Amount.toFixed(2)}`).join(' ')) }
}
