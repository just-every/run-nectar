// Every GET door, by name. http.ts and views.ts dispatch only through these
// lists, and the access proof (tests/nectar/flows.mjs) crawls every entry as
// each role, so a new door cannot be added without being checked.
// Patterns are relative to /api/nectar/ (API) or absolute (pages).
export const API_DOORS: [string, string][] = [
  ['^native-collections$','nativeCollections'],
  ['^prepaid/([\\w-]+/entries/[^/]+)$','prepaidSource'],
  ['^prepaid/([\\w-]+)$','prepaid'],
  ['^usage/corrections$','usageCorrections'],
  ['^openapi$','openapi'],
  ['^number-register$','numberRegister'],
  ['^billing-entities$','billingEntities'],
  ['^erasures$','erasures'],
  ['^revenue-journal$','revenueJournal'],
  ['^revenue$', 'revenue'], ['^revenue/([\\w-]+)$','revenueSource'],
  ['^cadences$', 'cadences'],
  ['^retention$','retention'],
  ['^report-schedule$', 'reportSchedule'], ['^report-deliveries/([\\w-]+)$','reportDelivery'],
  ['^proposals/([\\w-]+)/source$', 'setupSource'],
  ['^metadata/([a-z-]+/[\\w-]+)$', 'metadata'], ['^objects/([a-z-]+)$', 'metadataObjects'],
  ['^notifications$', 'notifications'],
  ['^notes/([\\w-]+/[\\w-]+)$', 'notes'], ['^note-members$', 'noteMembers'],
  ['^me$', 'me'], ['^business$', 'business'], ['^customers$', 'customers'], ['^customers/([\\w-]+)$', 'customer'], ['^catalog$', 'catalog'],
  ['^subscriptions/([\\w-]+)/upcoming$', 'upcoming'],
  ['^subscriptions/([\\w-]+)$', 'subscription'], ['^usage/batches$', 'batches'], ['^usage/inspect$', 'inspect'], ['^runs$', 'runs'], ['^runs/([\\w-]+)$', 'run'],
  ['^invoices$', 'invoices'], ['^invoices/([\\w-]+)$', 'invoice'], ['^ageing$', 'ageing'], ['^payments$', 'payments'], ['^notices$', 'notices'], ['^tasks$', 'tasks'],
  ['^policies/current$', 'policySettings'], ['^policies$', 'policies'], ['^proposals$', 'proposals'], ['^proposals/([\\w-]+)$', 'proposal'], ['^entitlements/([\\w.:-]+)$', 'entitlement'], ['^imports$', 'imports'], ['^shadow$', 'shadow'],
  ['^reports/([\\w-]+)$', 'report'], ['^reports/([\\w-]+/[\\w-]+)$', 'reportInvoice'], ['^invoices/([\\w-]+/lines/[\\w-]+)$', 'reportLine'],
  ['^members$', 'members'], ['^roles$', 'roles'], ['^credentials$', 'credentials'], ['^audit$', 'audit'], ['^mfa$', 'mfa'],
]

/** API doors whose rows page by cursor (DEV-002, list-cursor.ts); `invoices` keeps its own issuance-journal snapshot. */
export const LIST_DOORS = ['usageCorrections', 'erasures', 'noteMembers', 'customers', 'batches', 'runs', 'payments', 'notices', 'tasks', 'policies', 'proposals', 'imports', 'shadow', 'members', 'roles', 'credentials', 'audit', 'metadataObjects', 'notes']

export const PAGE_DOORS: [string, string][] = [
  ['^/app/exports/prepaid/([\\w-]+)\\.csv$','prepaidCsv'],
  ['^/app/import/([\\w-]+/originals/[a-f0-9]{64})$','importOriginals'],
  ['^/app/numbering$','numberRegister'], ['^/app/exports/number-register\\.csv$','numberRegisterCsv'],
  ['^/app/usage/replay$', 'usageReplay'],
  ['^/app/erasures$','erasures'],
  ['^/app/erasures/([\\w-]+)/evidence$','erasureEvidence'],
  ['^/app/exports/revenue-journal\\.csv$','revenueJournalCsv'],
  ['^/app/revenue$','revenue'], ['^/app/revenue/([\\w-]+)$','revenueSource'], ['^/app/exports/revenue\\.csv$','revenueCsv'],
  ['^/app/cadences$', 'cadences'],
  ['^/app/answers$', 'billingAnswers'],
  ['^/app/retention$','retention'],
  ['^/app/report-schedule$','reportSchedule'], ['^/app/report-deliveries/([\\w-]+)\\.csv$','reportDeliveryCsv'], ['^/app/report-deliveries/([\\w-]+)$','reportDelivery'], ['^/app/exports/reports/([\\w-]+)\\.csv$','reportCsv'],
  ['^/app/proposals/([\\w-]+)/source$', 'setupSource'],
  ['^/app/metadata$', 'metadataList'], ['^/app/metadata/([a-z-]+/[\\w-]+)$', 'metadata'], ['^/app/exports/objects/([a-z-]+)\\.csv$', 'metadataCsv'],
  ['^/app$', 'home'], ['^/app/more$', 'more'], ['^/app/settings$', 'settings'], ['^/app/customers$', 'customers'], ['^/app/customers/([\\w-]+)$', 'customer'],
  ['^/app/catalog$', 'catalog'], ['^/app/subscriptions/([\\w-]+)$', 'subscription'], ['^/app/usage$', 'usage'], ['^/app/billing$', 'billing'],
  ['^/app/billing/([\\w-]+)\\.json$', 'runFile'], ['^/app/billing/([\\w-]+)$', 'run'], ['^/app/invoices/([\\w-]+)$', 'invoice'], ['^/app/receivables$', 'receivables'],
  ['^/app/notices/([\\w-]+)\\.txt$', 'noticeFile'], ['^/app/proposals$', 'proposals'], ['^/app/proposals/([\\w-]+)$', 'proposal'], ['^/app/import$', 'import'],
  ['^/app/exports/customers\\.csv$', 'customersFile'],
  ['^/app/exports$', 'exports'], ['^/app/exports/invoices\\.csv$', 'invoicesFile'], ['^/app/exports/usage\\.csv$', 'usageFile'], ['^/app/exports/subscriptions\\.csv$', 'subscriptionsFile'],
  ['^/app/certificates/([\\w-]+)$', 'certificateFile'],
  ['^/app/reports/([\\w-]+)$', 'report'], ['^/app/reports/([\\w-]+/[\\w-]+)$', 'reportInvoice'], ['^/app/invoices/([\\w-]+/lines/[\\w-]+)$', 'reportLine'],
  ['^/app/access$', 'access'], ['^/app/audit$', 'audit'], ['^/app/security$', 'security'], ['^/app/security/passkey\\.js$', 'passkeyScript'],
]

export function match(doors: [string, string][], path: string): { name: string; id: string } | null {
  for (const [pattern, name] of doors) {
    const found = path.match(new RegExp(pattern))
    if (found) return { name, id: found[1] ?? '' }
  }
  return null
}
