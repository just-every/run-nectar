// Every string on the landing. The
// headline was changed on 15 Oct 2026 from "Invoices you can explain." because
// it shared its "… you can <verb>." shape with Pier's and Easel's headlines.
export const copy = {
  title: 'Nectar · Invoices, line by line',
  description: 'Free, open source subscription billing for B2B software and service businesses: plans, seats and usage turned into invoices that show every line’s calculation.',
  headline: 'Invoices, line by line.',
  subhead: 'Plans, seats and usage become invoices where every line shows how it was calculated.',
  rivals: ['Stripe Billing', 'Chargebee', 'Maxio'],
  run: 'Run Nectar',
  docs: 'Read the docs',
  small: 'Free and open source, MIT licensed.',
  sections: {
    free: { title: '100% free.', body: 'Nectar is MIT licensed: run it, change it and keep every record.' },
    explain: { title: 'Every charge has a reason.', body: 'Open any line to see the rule, quantity and price behind it.' },
    month: { title: 'The whole month on one page.', body: 'Each bill run drafts every invoice, compares it with last month and lists anything unusual.' },
    stripe: { title: 'Try it beside Stripe.', body: 'Bring in your Stripe Billing records, and Nectar rates them in shadow and compares every price before you switch.' },
    owed: { title: 'Know who owes what.', body: 'Ageing by customer, payments with their reference, and reminders ready to send from your own mail.' },
  },
  included: { title: 'Also included.', items: ['Versioned prices', 'Seats and metered usage', 'Previewed plan changes', 'Credit notes', 'Entitlements explained', 'Agents prepare, people approve'] },
} as const
