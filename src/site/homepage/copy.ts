// The landing's own strings: the document title, the hero copy approved on the
// design desk (18 Oct 2026) and the closing. Each story section keeps its copy
// beside its drawing in sections/.
export const copy = {
  title: 'Nectar · Bill right. Get paid.',
  description: 'Free, open source subscription and usage billing: Nectar prices every plan and meter, sends exact invoices, collects by card and ACH through your processor, recovers failed payments and ties out the month.',
  headline: ['Bill right.', 'Get paid.'],
  subhead: 'Nectar prices every plan and meter, sends exact invoices, collects by card and ACH through your processor, recovers failed payments and ties out the month.',
  rivals: ['Stripe Billing', 'Chargebee', 'Recurly'],
  run: 'Run Nectar',
  docs: 'Read the docs',
  // The hosted demo (Run demo workflow); it answered 200 on 18 Oct 2026.
  demo: 'https://demo.run-nectar.com/',
  closing: { first: 'Ready for', second: 'the 1st.', small: '100% free and open source. MIT licensed.' },
  footer: 'Free, open source subscription billing',
} as const
