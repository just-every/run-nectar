import type { Bindings } from '../auth.server'
import { US_STATES } from './business'
import { customerText } from './locale'
import { portalProfileData } from './portal-profile'
import type { CustomerSession } from './portal-session'
import { area, field, fileField, h, hidden, select } from './ui/html'

export async function portalProfilePage(env: Bindings, session: CustomerSession, link: (path: string) => string) {
  const L = customerText(session.language, session.currency), data = await portalProfileData(env, session)
  const action = link('/portal/profile')
  const operation = (value: string) => hidden('operation', value)
  const contactFields = (name = '', email = '') => h`${field(L.t('profile.contact.name'), 'name', { value: name })}${field(L.t('profile.contact.email'), 'email', { type: 'email', value: email })}`
  return h`<h1>${L.t('profile.heading')}</h1><p><a href="${link('/portal')}">${L.t('portal.back')}</a></p>
    <section class="card"><h2>${L.t('profile.address')}</h2><p>${data.name}</p>
      <p>${L.t('profile.primaryEmail')}: ${data.billingEmail}</p><p class="hint">${L.t('profile.primaryEmail.hint')}</p>
      <form method="post" action="${action}">${operation('address')}${hidden('revision', data.revision)}
        ${area(L.t('profile.address'), 'address', data.address, false)}<button>${L.t('profile.saveAddress')}</button></form>
    </section>
    <section class="card"><h2>${L.t('profile.contacts')}</h2>
      ${data.contacts.length ? data.contacts.map(contact => h`<div class="card">
        <form method="post" action="${action}">${operation('contact.update')}${hidden('contact', contact.id)}${hidden('revision', contact.revision)}
          ${contactFields(contact.name, contact.email)}<button>${L.t('profile.contact.save')}</button></form>
        <form method="post" action="${action}">${operation('contact.remove')}${hidden('contact', contact.id)}${hidden('revision', contact.revision)}
          <button class="secondary">${L.t('profile.contact.remove')}</button></form></div>`) : h`<p>${L.t('profile.contacts.empty')}</p>`}
      <h3>${L.t('profile.contact.add')}</h3><form method="post" action="${action}">${operation('contact.add')}${contactFields()}
        <button>${L.t('profile.contact.add')}</button></form>
    </section>
    <section class="card"><h2>${L.t('profile.taxIds')}</h2><p>${L.t('profile.taxIds.hint')}</p>
      ${data.taxIds.length ? data.taxIds.map(tax => h`<div class="card"><p>${tax.type}: ${tax.value}</p><p>${L.t('profile.tax.unverified')}</p>
        <form method="post" action="${action}">${operation('tax.remove')}${hidden('tax', tax.id)}<button class="secondary">${L.t('profile.tax.remove')}</button></form></div>`) : h`<p>${L.t('profile.taxIds.empty')}</p>`}
      <form method="post" action="${action}">${operation('tax.add')}${field(L.t('profile.tax.type'), 'type')}${field(L.t('profile.tax.value'), 'value')}
        <button>${L.t('profile.tax.add')}</button></form>
    </section>
    <section class="card"><h2>${L.t('profile.certificates')}</h2><p>${L.t('profile.certificates.hint')}</p>
      ${data.certificates.length ? data.certificates.map(certificate => h`<div class="card"><h3>${certificate.state} · ${certificate.reference}</h3>
        <p>${L.t(`profile.certificate.status.${certificate.status}`)}</p><p>${L.t('profile.certificate.dates', { from: L.day(certificate.validFrom), to: L.day(certificate.expiresOn) })}</p>
        <a href="${link(`/portal/profile/certificates/${encodeURIComponent(certificate.id)}`)}">${L.t('profile.certificate.download')}: ${certificate.filename}</a></div>`) : h`<p>${L.t('profile.certificates.empty')}</p>`}
      <h3>${L.t('profile.certificate.upload')}</h3><form method="post" action="${action}" enctype="multipart/form-data">${operation('certificate.upload')}
        ${select(L.t('profile.certificate.state'), 'state', US_STATES.map(state => ({ value: state, label: state })), '', { blank: L.t('profile.certificate.chooseState') })}
        ${field(L.t('profile.certificate.reference'), 'reference')}${field(L.t('profile.certificate.validFrom'), 'valid_from', { type: 'date' })}
        ${field(L.t('profile.certificate.expiresOn'), 'expires_on', { type: 'date' })}
        ${fileField(L.t('profile.certificate.file'), 'file', { required: true, accept: 'application/pdf,image/png,image/jpeg', hint: L.t('profile.certificate.fileHint') })}
        <button>${L.t('profile.certificate.upload')}</button></form>
    </section>
    <section class="card"><h2>${L.t('profile.w9')}</h2>${data.merchantW9Available
      ? h`<a href="${link('/portal/profile/merchant-w9')}">${L.t('profile.w9.download')}</a>`
      : h`<p>${L.t('profile.w9.empty')}</p>`}</section>`
}
