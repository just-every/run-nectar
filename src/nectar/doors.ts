// Every GET door, by name. http.ts and views.ts dispatch only through these
// lists, and the access proof (tests/nectar/flows.mjs) crawls every entry as
// each role, so a new door cannot be added without being checked.
// Patterns are relative to /api/nectar/ (API) or absolute (pages).
export const API_DOORS: [string, string][] = [
  ['^notes/([\\w-]+/[\\w-]+)$', 'notes'], ['^note-members$', 'noteMembers'],
  ['^me$', 'me'], ['^business$', 'business'], ['^customers$', 'customers'], ['^customers/([\\w-]+)$', 'customer'], ['^catalog$', 'catalog'],
  ['^subscriptions/([\\w-]+)/upcoming$', 'upcoming'],
  ['^subscriptions/([\\w-]+)$', 'subscription'], ['^usage/batches$', 'batches'], ['^usage/inspect$', 'inspect'], ['^runs$', 'runs'], ['^runs/([\\w-]+)$', 'run'],
  ['^invoices$', 'invoices'], ['^invoices/([\\w-]+)$', 'invoice'], ['^ageing$', 'ageing'], ['^payments$', 'payments'], ['^notices$', 'notices'], ['^tasks$', 'tasks'],
  ['^policies/current$', 'policySettings'], ['^policies$', 'policies'], ['^proposals$', 'proposals'], ['^proposals/([\\w-]+)$', 'proposal'], ['^entitlements/([\\w.:-]+)$', 'entitlement'], ['^imports$', 'imports'], ['^shadow$', 'shadow'],
  ['^reports/([\\w-]+)$', 'report'], ['^reports/([\\w-]+/[\\w-]+)$', 'reportInvoice'], ['^invoices/([\\w-]+/lines/[\\w-]+)$', 'reportLine'],
  ['^members$', 'members'], ['^credentials$', 'credentials'], ['^audit$', 'audit'],
]

export const PAGE_DOORS: [string, string][] = [
  ['^/app$', 'home'], ['^/app/more$', 'more'], ['^/app/settings$', 'settings'], ['^/app/customers$', 'customers'], ['^/app/customers/([\\w-]+)$', 'customer'],
  ['^/app/catalog$', 'catalog'], ['^/app/subscriptions/([\\w-]+)$', 'subscription'], ['^/app/usage$', 'usage'], ['^/app/billing$', 'billing'],
  ['^/app/billing/([\\w-]+)\\.json$', 'runFile'], ['^/app/billing/([\\w-]+)$', 'run'], ['^/app/invoices/([\\w-]+)$', 'invoice'], ['^/app/receivables$', 'receivables'],
  ['^/app/notices/([\\w-]+)\\.txt$', 'noticeFile'], ['^/app/proposals$', 'proposals'], ['^/app/proposals/([\\w-]+)$', 'proposal'], ['^/app/import$', 'import'],
  ['^/app/exports/customers\\.csv$', 'customersFile'],
  ['^/app/exports$', 'exports'], ['^/app/exports/invoices\\.csv$', 'invoicesFile'], ['^/app/exports/usage\\.csv$', 'usageFile'], ['^/app/exports/subscriptions\\.csv$', 'subscriptionsFile'],
  ['^/app/certificates/([\\w-]+)$', 'certificateFile'],
  ['^/app/reports/([\\w-]+)$', 'report'], ['^/app/reports/([\\w-]+/[\\w-]+)$', 'reportInvoice'], ['^/app/invoices/([\\w-]+/lines/[\\w-]+)$', 'reportLine'],
  ['^/app/access$', 'access'], ['^/app/audit$', 'audit'],
]

export function match(doors: [string, string][], path: string): { name: string; id: string } | null {
  for (const [pattern, name] of doors) {
    const found = path.match(new RegExp(pattern))
    if (found) return { name, id: found[1] ?? '' }
  }
  return null
}
