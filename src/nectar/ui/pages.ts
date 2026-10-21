import { numberRegisterPage } from './number-register'
import { numberRegisterExport } from '../number-register'
import { usageReplayPage } from './usage-replay'
import { erasurePage } from './erasure'
import { erasureEvidence } from '../erasure-requests'
import { revenuePage,revenueSourcePage } from './revenue'
import { revenueCsv } from '../revenue-reports'
import { cadencesPage } from './cadences'
import { billingAnswersPage } from './billing-answers'
import { retentionPage } from './retention'
import { h,page } from './html'
import { issueCancellationLink } from '../renewal-terms'
import { reportSchedulePage,reportDeliveryPage } from './report-schedules'
import { reportDeliveryCsv } from '../report-schedules'
import { reportCsv } from '../report-csv'
import { setupSourceDownload } from '../setup-download'
import { passkeyScript, securityPage, securityPosts } from './security'
// Every page door's renderer, by the name in doors.ts, and the two POST pages
// that render a result instead of redirecting (a move-in preview, and a new
// credential that is shown once and never put in a URL).
import type { Bindings } from '../../auth.server'
import { certificateFile } from '../certificates'
import { issueKey } from '../access'
import type { Actor } from '../actor'
import { exportReminder } from '../collections'
import { billRunJson, customersCsv, invoicesCsv, subscriptionsCsv, usageCsv } from '../exports'
import type { Input } from '../input'
import { metadataPage,metadataListPage } from './metadata'
import { metadataCsv } from '../metadata-lists'
import { billingPage, invoicePage, runPage } from './billing'
import { customerPage, customersPage, subscriptionPage } from './customers'
import { accessPage, auditPage, homePage, morePage, settingsPage } from './home'
import { exportsPage, importPage, previewPage, proposalPage, proposalsPage } from './review'
import { receivablesPage } from './receivables'
import { catalogPage, usagePage } from './work'
import { reportPage, reportInvoicePage, reportLinePage } from './reports'

type Page = (env: Bindings, actor: Actor, request: Request, url: URL, id: string) => Promise<Response>

export const pages: Record<string, Page> = {
  numberRegister:(env,actor,_r,url)=>numberRegisterPage(env,actor,url),
  numberRegisterCsv:(env,actor)=>numberRegisterExport(env,actor),
  usageReplay:(env,actor,_r,url)=>usageReplayPage(env,actor,url),
  erasures:(env,actor,_r,url)=>erasurePage(env,actor,url),
  erasureEvidence:(env,actor,_r,_u,id)=>erasureEvidence(env,actor,id),
  revenue:(env,actor,_r,url)=>revenuePage(env,actor,url),
  revenueSource:(env,actor,_r,url,id)=>revenueSourcePage(env,actor,id,url),
  revenueCsv:(env,actor,_r,url)=>revenueCsv(env,actor,url),
  cadences:(env,actor,_r,url)=>cadencesPage(env,actor,url),
  billingAnswers:(env,actor,_r,url)=>billingAnswersPage(env,actor,url),
  retention:(env,actor,_r,url)=>retentionPage(env,actor,url),
  reportSchedule:(env,actor,_r,url)=>reportSchedulePage(env,actor,url),
  reportDelivery:(env,actor,_r,url,id)=>reportDeliveryPage(env,actor,id,url),
  reportDeliveryCsv:(env,actor,_r,_url,id)=>reportDeliveryCsv(env,actor,id),
  reportCsv:(env,actor,_r,url,id)=>reportCsv(env,actor,id,url),
  setupSource:(env,actor,_r,_url,id)=>setupSourceDownload(env,actor,id),
  metadata: (env,actor,_r,url,id) => {const [kind,record]=id.split('/');return metadataPage(env,actor,kind,record,url)},
  metadataList: (env,actor,_r,url) => metadataListPage(env,actor,url),
  metadataCsv: (env,actor,_r,url,id) => metadataCsv(env,actor,id,url),
  home: (env, actor, _r, url) => homePage(env, actor, url),
  more: (env, actor, _r, url) => morePage(env, actor, url),
  settings: (env, actor, _r, url) => settingsPage(env, actor, url),
  customers: (env, actor, _r, url) => customersPage(env, actor, url),
  certificateFile: (env, actor, _r, _url, id) => certificateFile(env, actor, id),
  customer: (env, actor, _r, url, id) => customerPage(env, actor, id, url),
  subscription: (env, actor, _r, url, id) => subscriptionPage(env, actor, id, url),
  catalog: (env, actor, _r, url) => catalogPage(env, actor, url),
  usage: (env, actor, _r, url) => usagePage(env, actor, url),
  billing: (env, actor, _r, url) => billingPage(env, actor, url),
  run: (env, actor, _r, url, id) => runPage(env, actor, id, url),
  runFile: (env, actor, _r, _url, id) => billRunJson(env, actor, id),
  invoice: (env, actor, _r, url, id) => invoicePage(env, actor, id, url),
  receivables: (env, actor, _r, url) => receivablesPage(env, actor, url),
  noticeFile: (env, actor, _r, _url, id) => exportReminder(env, actor, id),
  proposals: (env, actor, _r, url) => proposalsPage(env, actor, url),
  proposal: (env, actor, _r, url, id) => proposalPage(env, actor, id, url),
  import: (env, actor, _r, url) => importPage(env, actor, url),
  exports: (env, actor, _r, url) => exportsPage(env, actor, url),
  customersFile: (env, actor,_r,url) => customersCsv(env, actor,url),
  invoicesFile: (env, actor,_r,url) => invoicesCsv(env, actor,url),
  usageFile: (env, actor) => usageCsv(env, actor),
  subscriptionsFile: (env, actor,_r,url) => subscriptionsCsv(env, actor,url),
  access: (env, actor, _r, url) => accessPage(env, actor, url),
  audit: (env, actor, _r, url) => auditPage(env, actor, url),
  security: (env, actor, _r, url) => securityPage(env, actor, url),
  passkeyScript: () => passkeyScript(),
  report: (env, actor, _r, url, id) => reportPage(env, actor, id, url),
  reportInvoice: (env, actor, _r, url, id) => { const [metric, invoice] = id.split('/'); return reportInvoicePage(env, actor, metric, invoice, url) },
  reportLine: (env, actor, _r, url, id) => { const [invoice, , line] = id.split('/'); return reportLinePage(env, actor, invoice, line, url) },
}

type PostPage = (env: Bindings, actor: Actor, input: Input, url: URL, request: Request) => Promise<Response>

export const postPages: Record<string, PostPage> = {
  '/app/usage/replay':(env,actor,input,url)=>usageReplayPage(env,actor,url,input),
  ...securityPosts,
  '/app/answers':(env,actor,input,url)=>billingAnswersPage(env,actor,url,input),
  '/app/renewal-link':async(env,actor,input)=>{const result=await issueCancellationLink(env,actor,input);return page('Cancellation link',actor,h`<h1>Cancellation link</h1><section class="card"><p>The previous link is now inactive. Share this private link only with this subscription’s customer. It allows cancellation of the next renewal only.</p><p><a href="${result.cancelUrl}">Open cancellation page</a></p><p><a href="/app/subscriptions/${result.id}#renewals">Back to subscription</a></p></section>`)},
  '/app/import/preview': (env, actor, input, url) => previewPage(env, actor, input, url),
  '/app/access/credential': async (env, actor, input, url) => {
    const issued = await issueKey(env, actor, input)
    return accessPage(env, actor, url, issued)
  },
}
