import { customerText, languages } from './locale'
import { portalPage } from './portal-page'
import { h } from './ui/html'

export function portalSigninPage(language: string, mode: 'request' | 'sent' | 'confirm' | 'invalid' | 'unavailable', action = '/portal/signin', status = 200) {
  const L = customerText(language), title = L.t('portal.signin.title')
  const form = mode === 'request' ? h`<p>${L.t('portal.signin.intro')}</p><form method="post" action="/portal/signin"><input type="hidden" name="language" value="${L.tag}"><p><label>${L.t('portal.signin.customer')}<br><input name="customer" required maxlength="100" autocomplete="organization"></label></p><p><label>${L.t('portal.signin.email')}<br><input name="email" type="email" required maxlength="254" autocomplete="email"></label></p><button type="submit">${L.t('portal.signin.send')}</button></form><p>${languages().map(item => h`<a href="/portal/signin?language=${item.value}" lang="${item.value}">${item.label}</a> `)}</p>`
    : mode === 'confirm' ? h`<p>${L.t('portal.signin.confirmText')}</p><form method="post" action="${action}"><button type="submit">${L.t('portal.signin.confirm')}</button></form>`
    : h`<p role="status">${L.t(`portal.signin.${mode}`)}</p><a href="/portal/signin?language=${L.tag}">${L.t('portal.signin.again')}</a>`
  const response = portalPage(title, h`<h1>${title}</h1><section class="card">${form}</section>`, { lang: L.tag, status })
  response.headers.set('content-security-policy', "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
  response.headers.set('referrer-policy', 'strict-origin')
  return response
}
