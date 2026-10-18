// The one billing month the homepage follows (Fieldnote Software, Denver, CO),
// as the desk's records table states it: every figure that appears in more
// than one section is read from here, so the hero, the stories and the close
// always agree.
export const run = {
  invoices: 212,
  first: 'FN-2041',
  last: 'FN-2252',
  prepared: 'Wed Sep 30, 6:00 pm',
  issued: 'Thu Oct 1, 6:00 am',
  plans: '$149,620.00',
  usage: '$31,287.82',
  tax: '$3,412.18',
  taxedInvoices: 87,
  total: '$184,320.00',
  card: 131,
  ach: 37,
  terms: 44,
  // September billed seats and tax only (its usage was Stripe's, MOVE-010).
  september: { invoices: 206, total: '$146,872.40' },
}

export const lakeview = {
  invoice: 'FN-2041',
  seats: 48,
  seatPrice: '$95.00',
  seatsTotal: '$4,560.00',
  calls: '1,200,000',
  callsTotal: '$2,280.00',
  tierOne: '$2,000.00',
  tierTwo: '$280.00',
  total: '$6,840.00',
  card: 'Visa •• 8817',
  paid: 'Thu Oct 1, 6:02 am',
  next: 'FN-2253',
}

export const mesa = { invoice: 'FN-2087', amount: '$1,290.00', card: 'Visa •• 5150', retried: 'Mon Oct 5' }
export const pinecrest = { invoice: 'FN-2133', amount: '$2,150.00', settled: 'Wed Oct 7', practice: '$2,150', group: '$2,790', prorated: '$412.90', next: '$3,202.90' }

export const close = {
  collected: '$174,460.00',
  paid: 209,
  open: '$9,860.00',
  payouts: '$171,402.37',
  fees: '$3,057.63',
  mrrFrom: '$171,500',
  mrrTo: '$178,230',
  expansion: '+$8,940',
  churn: '−$2,210',
}

export const usage = { api: '38,200,000', sdk: '3,100,000', rows: '512,406', total: '41,812,406' }
