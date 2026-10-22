import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPolicy } from './policy-helper.mjs'

// PORT-006: per-customer language over every customer-facing message and page
// Nectar has today, through the built Worker's public doors and its mail edge.
const figures = text => text.match(/-?USD [\d,]+\.\d{2}/g) ?? []
const linkIn = (text, kind) => new URL(text.match(new RegExp(`http://[^\\s]+/${kind}/[a-f0-9]{64}`))[0]).pathname
const LANGS = ['es-US', 'en']

export async function customerLanguageFlow(h, owner) {
  const tick = async stamp => {
    await h.advanceClock(stamp)
    const response = await h.raw(`/cdn-cgi/local/scheduled?time=${Date.parse(stamp)}&cron=${encodeURIComponent('0 14 * * *')}`)
    assert.equal(response.status, 200)
  }
  const mailTo = (to, since) => h.mails.slice(since).filter(mail => [mail.to].flat().includes(to))
  await h.advanceClock('2026-01-01T16:00:00Z')

  // The language is a customer field on the JSON door and the form, limited to complete translation files.
  assert.equal((await h.api('customer.create', owner, { external_id: 'PORT006-XX', name: 'Unknown Language', billing_email: 'xx@lang.example', language: 'xx' }, 400)).error, 'unsupported_language', 'PORT-006 only a shipped translation file is a language')
  const people = {}
  for (const language of LANGS) {
    const code = language === 'en' ? 'EN' : 'ES'
    people[language] = { email: `${code.toLowerCase()}@lang.example`, customer: (await h.api('customer.create', owner, { external_id: `PORT006-${code}`, name: language === 'en' ? 'Cypress Analytics' : 'Ciprés Analítica', billing_email: `${code.toLowerCase()}@lang.example`, ...(language === 'en' ? {} : { language }) })).id }
  }
  const page = await (await h.raw(`/app/customers/${people['es-US'].customer}`, { cookie: owner })).text()
  assert.match(page, /Customer language<\/dt><dd>Español \(EE\. UU\.\)/, 'PORT-006 the customer record shows its language')
  assert.match(page, /<option value="en"[^>]*>English<\/option>/); assert.match(page, /<option value="es-US" selected[^>]*>Español/)
  const english = await h.api(`customers/${people.en.customer}`, owner)
  assert.equal(english.language, 'en', 'PORT-006 English is the default')
  const switched = await h.submit('customer.update', owner, { customer: english.id, revision: english.revision, name: english.name, billing_email: english.billing_email, language: 'es-US' }, `/app/customers/${english.id}`)
  assert.equal(switched.searchParams.get('error'), null)
  assert.equal((await h.api(`customers/${english.id}`, owner)).language, 'es-US', 'PORT-006 the form door sets the language')
  const back = await h.api(`customers/${english.id}`, owner)
  await h.api('customer.update', owner, { customer: back.id, revision: back.revision, name: back.name, billing_email: back.billing_email, language: 'en' })

  // SUB-004 renewal notice + bearer page and SUB-005 save/win-back, in each language with the same figures.
  const prior = (await h.api('retention', owner)).policy
  const saved = await h.api('retention.policy.prepare', owner, { ...prior, revision: prior.revision, enabled: true, save_kind: 'discount', save_percent: 50, save_months: 2, winback_enabled: true, winback_days: 60, winback_percent: 30, winback_months: 3 })
  await h.api('retention.policy.decide', owner, { request: saved.request, decision: 'approved', confirm_single: true })
  const product = (await h.api('product.create', owner, { code: 'port006-platform', name: 'Cedar platform' })).id
  const price = (await h.api('price.create', owner, { product, kind: 'flat', unit_amount: '100', taxable: false })).id
  for (const language of LANGS) {
    const who = people[language]
    who.sub = (await h.api('subscription.create', owner, { customer: who.customer, start_date: '2025-04-01', price: [price] })).id
    const term = await h.api('term.prepare', owner, { subscription: who.sub, revision: (await h.api(`subscriptions/${who.sub}`, owner)).revision, term_start: '2025-04-01', months: 12, auto_renew: true, notice_days: 30, uplift_percent: '5' })
    await h.api('term.decide', owner, { term: term.term, decision: 'approved', confirm_single: true })
  }
  let since = h.mails.length
  await tick('2026-03-02T16:00:00Z')
  const notice = Object.fromEntries(LANGS.map(language => [language, mailTo(people[language].email, since).find(mail => mail.subject.includes('2026'))]))
  assert.equal(notice['es-US'].subject, 'Renovación de la suscripción el 1 de abril de 2026', 'PORT-006 Spanish renewal notice subject and long date')
  assert.equal(notice.en.subject, 'Subscription renewal on April 1, 2026')
  assert.match(notice['es-US'].text, /Su suscripción se renueva el 1 de abril de 2026 hasta el 1 de abril de 2027\. Aumento en la renovación: 5 %\./)
  assert.match(notice['es-US'].text, /Subtotal USD 105\.00, impuestos USD 0\.00, total USD 105\.00\./)
  assert.deepEqual(figures(notice['es-US'].text), figures(notice.en.text), 'PORT-006 the Spanish notice carries the same figures as the English one')
  assert.ok(figures(notice.en.text).length >= 4)

  const renewalPage = {}
  for (const language of LANGS) renewalPage[language] = await (await h.raw(linkIn(notice[language].text, 'renewal'))).text()
  assert.match(renewalPage['es-US'], /<html lang="es-US">/)
  assert.match(renewalPage['es-US'], /Administre su renovación/); assert.match(renewalPage['es-US'], /El plazo actual termina el 1 de abril de 2026\./)
  assert.match(renewalPage['es-US'], /Oferta opcional: 50 % de descuento en cargos fijos y por usuario durante 2 períodos mensuales\./)
  assert.match(renewalPage['es-US'], /Motivo \(opcional\)/); assert.match(renewalPage['es-US'], />Cancelar renovación</)
  assert.match(renewalPage.en, /<html lang="en">/); assert.match(renewalPage.en, /Current term ends April 1, 2026\./)
  assert.doesNotMatch(renewalPage['es-US'], /renewal\.|Manage your renewal/, 'PORT-006 no key or English text leaks into the Spanish page')
  for (const language of LANGS) {
    const done = await (await h.raw(linkIn(notice[language].text, 'renewal'), { form: new URLSearchParams({ confirm: 'cancel' }) })).text()
    assert.match(done, language === 'en' ? /Your subscription will end on April 1, 2026\./ : /Renovación cancelada.*Su suscripción terminará el 1 de abril de 2026\./s)
  }
  const unknown = await h.raw(`/renewal/${'0'.repeat(64)}`)
  assert.equal(unknown.status, 404); assert.match(await unknown.text(), /This renewal link is no longer active/, 'PORT-006 a link naming no customer uses the default language')

  since = h.mails.length
  await tick('2026-04-01T16:00:00Z')
  const winback = Object.fromEntries(LANGS.map(language => [language, mailTo(people[language].email, since)[0]]))
  assert.equal(winback['es-US'].subject, 'Su oferta para regresar a la suscripción', 'PORT-006 Spanish win-back mail')
  assert.match(winback['es-US'].text, /30 % de descuento en cargos fijos y por usuario durante 3 períodos de facturación mensuales\. .*La oferta vence el 31 de mayo de 2026 en America\/Los_Angeles\./)
  assert.match(winback.en.text, /Offer expires May 31, 2026 in America\/Los_Angeles\./)
  const offer = await (await h.raw(linkIn(winback['es-US'].text, 'return'))).text()
  assert.match(offer, /<html lang="es-US">/); assert.match(offer, /Su oferta de regreso/); assert.match(offer, /Vence el 31 de mayo de 2026\./)
  const resumed = await (await h.raw(linkIn(winback['es-US'].text, 'return'), { form: new URLSearchParams({ confirm: 'accept' }) })).text()
  assert.match(resumed, /Suscripción reanudada.*Su servicio se reanuda el 1 de abril de 2026\. Se aplica un 30 % de descuento/s, 'PORT-006 the Spanish return page confirms in Spanish')
  assert.match(await (await h.raw(linkIn(winback.en.text, 'return'), { form: new URLSearchParams({ confirm: 'accept' }) })).text(), /Subscription resumed.*Your service resumes April 1, 2026\./s)

  // AR-001: the owner's rule text is sent as written; Nectar's appended facts follow the customer's language.
  await h.advanceClock('2026-09-01T19:00:00Z')
  const invoices = {}
  for (const language of LANGS) {
    const who = people[language]
    const charges = [(await h.api('charge.add', owner, { customer: who.customer, amount: '1234.50', description: 'Implementation', taxable: false, effective_date: '2026-09-01' })).charge]
    const draft = await h.api('invoice.manual', owner, { customer: who.customer, charges, service_date: '2026-09-01' })
    await h.api('invoice.approve', owner, { invoice: draft.id, acknowledge: true })
    await h.api('invoice.finalise', owner, { invoice: draft.id, issue_date: '2026-09-01' })
    invoices[language] = await h.api(`invoices/${draft.id}`, owner)
    await h.api('cadence.enroll', owner, { invoice: draft.id, segment: 'transfer', transfer_terms: 'Bank transfer, Net30, recorded from the signed order.' })
  }
  const rule = { segment: 'transfer', minimum_cents: 100, subject: '{business}: {invoice}, {balance}', body: 'Please arrange the recorded transfer for {invoice}.' }
  const cadence = await h.api('cadence.policy.prepare', owner, { enabled: true, require_human: false, rules: [rule] })
  await h.api('cadence.policy.decide', owner, { request: cadence.request, decision: 'approved', confirm_single: true })
  since = h.mails.length
  await tick('2026-09-28T19:00:00Z')
  const reminder = Object.fromEntries(LANGS.map(language => [language, mailTo(people[language].email, since)[0]]))
  assert.equal(reminder['es-US'].text, `Please arrange the recorded transfer for ${invoices['es-US'].number}.\n\nFactura ${invoices['es-US'].number}; vence el 1 de octubre de 2026.\nImporte solicitado: USD 1,234.50.`, 'PORT-006 owner text as written, Nectar facts in Spanish')
  assert.equal(reminder.en.text, `Please arrange the recorded transfer for ${invoices.en.number}.\n\nInvoice ${invoices.en.number}; due October 1, 2026.\nAmount requested: USD 1,234.50.`)
  assert.equal(reminder['es-US'].subject, `Cedar Software Inc: ${invoices['es-US'].number}, USD 1,234.50`)

  // TAX-002 certificate reminders.
  await applyPolicy(h, owner, 'tax.declare', { tax_jurisdiction: 'TX', tax_mode: 'flat_rate', tax_rate: '10', tax_note: 'Reviewed declared rate for the language journey' })
  await h.api('tax.review', owner, { revision: (await h.api('business', owner)).revision })
  for (const language of LANGS) await h.api('exemption.claim', owner, { customer: people[language].customer, state: 'TX' })
  await applyPolicy(h, owner, 'certificate.policy', { enabled: true })
  since = h.mails.length
  await tick('2026-10-02T14:00:00Z')
  const certificate = Object.fromEntries(LANGS.map(language => [language, mailTo(people[language].email, since).find(mail => mail.subject.includes('TX'))]))
  assert.equal(certificate['es-US'].subject, 'Certificado de exención de TX: pendiente de entrega', 'PORT-006 Spanish certificate reminder')
  assert.match(certificate['es-US'].text, /^Ciprés Analítica: su certificado de exención de TX está pendiente de entrega\. Envíe un certificado vigente a /)
  assert.equal(certificate.en.subject, 'TX exemption certificate missing')

  // AGENT-002 draft-correction notices are generated in the customer's language with the same engine figures.
  const agent = { bearer: (await h.api('credential.issue', owner, { name: 'Language agent', scopes: ['prepare'] })).key }
  const drafts = {}
  for (const language of LANGS) {
    const proposal = await h.api('proposal.create', agent, { kind: 'amendment', title: 'Executed recurring discount', payload: { subscription: people[language].sub, kind: 'discount_percent', value: '10', effective_from: '2026-11-01', note: 'Reviewed discount' },
      evidence: { clauses: [{ quote: 'From 1 November 2026 the platform fee is reduced by ten percent.', reference: 'Executed amendment, section 1' }] } })
    drafts[language] = (await h.api(`proposals/${proposal.id}`, owner)).payload.noticeDrafts[0]
  }
  assert.equal(drafts['es-US'].subject, 'Corrección de facturación y explicación del borrador de factura', 'PORT-006 Spanish correction notice')
  assert.match(drafts['es-US'].body, /^Hola, Ciprés Analítica:/)
  assert.match(drafts['es-US'].body, /Descuento recurrente: 10 %; vigente desde el 1 de noviembre de 2026, sin fecha de finalización registrada\./)
  assert.match(drafts['es-US'].body, /Próximo período de servicio facturado afectado: del 1 de noviembre de 2026 al 1 de diciembre de 2026/)
  assert.match(drafts.en.body, /Recurring discount: 10%; effective November 1, 2026, with no recorded end date\./)
  assert.deepEqual(figures(drafts['es-US'].body), figures(drafts.en.body), 'PORT-006 the Spanish explanation carries the same figures as the English one')
  assert.ok(figures(drafts.en.body).length >= 6)
}

/** Runs against a build that added only tests/fixtures/locales/fr.json. */
export async function frenchFlow(h, owner) {
  const customer = (await h.api('customer.create', owner, { external_id: 'PORT006-FR', name: 'Cyprès Analytique', billing_email: 'fr@lang.example', language: 'fr' })).id
  const product = (await h.api('product.create', owner, { code: 'port006-fr', name: 'Plateforme' })).id
  const price = (await h.api('price.create', owner, { product, kind: 'flat', unit_amount: '100', taxable: false })).id
  const sub = (await h.api('subscription.create', owner, { customer, start_date: '2026-01-01', price: [price] })).id
  const term = await h.api('term.prepare', owner, { subscription: sub, revision: (await h.api(`subscriptions/${sub}`, owner)).revision, term_start: '2026-01-01', months: 12, auto_renew: true, notice_days: 30, uplift_percent: '5' })
  await h.api('term.decide', owner, { term: term.term, decision: 'approved', confirm_single: true })
  const html = await (await h.raw(new URL((await h.api('term.link', owner, { term: term.term })).cancelUrl).pathname)).text()
  assert.match(html, /<html lang="fr">/); assert.match(html, /Gérez votre renouvellement/)
  assert.match(html, /La période en cours se termine le 1 janvier 2027\./, 'PORT-006 a French customer’s page switches with no code change')
  assert.match(await (await h.raw(`/app/customers/${customer}`, { cookie: owner })).text(), /Customer language<\/dt><dd>Français/)
}

export async function incompleteFrenchFlow(h, owner) {
  assert.equal((await h.api('customer.create', owner, { external_id: 'PORT006-FR', name: 'Cyprès Analytique', billing_email: 'fr@lang.example', language: 'fr' }, 400)).error, 'unsupported_language', 'PORT-006 an incomplete file is never offered, so no customer sees a key')
}

/** The check, then a real build of a copy with only a French file added. */
export async function translationFiles() {
  const check = dir => spawnSync(process.execPath, ['scripts/check-locales.mjs', ...(dir ? [dir] : [])], { encoding: 'utf8' })
  assert.equal(check().status, 0, 'PORT-006 the shipped translation files are complete')
  const french = JSON.parse(await readFile('tests/fixtures/locales/fr.json', 'utf8'))
  const root = await mkdtemp(join(tmpdir(), 'nectar-port006-')), home = process.cwd()
  try {
    for (const name of ['src', 'public', 'migrations', 'package.json', 'vite.config.ts', 'tsconfig.json', 'wrangler.jsonc', 'deploy-site.json', 'edition.json', 'rer-project.json', 'seed.json'])
      await cp(name, join(root, name), { recursive: true })
    await symlink(join(home, 'node_modules'), join(root, 'node_modules'))
    const locale = join(root, 'src/nectar/locales/fr.json')
    const build = () => assert.equal(spawnSync(join(home, 'node_modules/.bin/vite'), ['build'], { cwd: root, encoding: 'utf8' }).status, 0, 'copy builds')
    await writeFile(locale, JSON.stringify(french, null, 2))
    assert.equal(check(join(root, 'src/nectar/locales')).status, 0, 'The added French catalogue is complete')
    build()
    // Each built copy initializes its runtime in its own working directory.
    const journey = name => {
      const result=spawnSync(process.execPath,[join(home,'tests/nectar/clause-runner.mjs'),'customer-language',name],{cwd:root,encoding:'utf8',timeout:180000,killSignal:'SIGKILL'})
      const diagnostic=String(result.error?.message??result.stderr).replace(/\/(renew|return|erase)\/[a-f0-9]{64}/g,'/$1/[redacted]').replace(/(token=|rer-dev=|RER_DEV_KEY=)[^&\s"']+/g,'$1[redacted]')
      assert.equal(result.status,0,`PORT-006 ${name}: ${diagnostic}`)
    }
    journey('frenchFlow')
    const { ['renewal.manage.heading']: _, ...missing } = french
    await writeFile(locale, JSON.stringify(missing, null, 2))
    const failed = check(join(root, 'src/nectar/locales'))
    assert.equal(failed.status, 1, 'PORT-006 a missing string fails the check')
    assert.match(failed.stderr, /fr\.json: missing renewal\.manage\.heading/)
    build()
    journey('incompleteFrenchFlow')
  } finally { await rm(root, { recursive: true, force: true }) }
}
