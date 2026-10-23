/// <reference types="vite/client" />
// PORT-006 customer-facing language. Every src/nectar/locales/<tag>.json is a
// language, discovered at build: adding a complete file adds a language with no
// code change. en.json defines the keys; an incomplete file is never offered,
// so a customer never sees a key. Amounts keep the invoice's currency.
import { catalogueProblems, type Catalogue } from './locale-keys'
import { insist } from './core'

const files = import.meta.glob('./locales/*.json', { eager: true, import: 'default' }) as Record<string, Catalogue>
const base = files['./locales/en.json']
const catalogues = new Map(Object.entries(files)
  .map(([path, catalogue]) => [path.slice('./locales/'.length, -'.json'.length), catalogue] as const)
  .filter(([, catalogue]) => catalogueProblems(base, catalogue).length === 0))

export const DEFAULT_LANGUAGE = 'en'
export const languages = () => [...catalogues].map(([tag, c]) => ({ value: tag, label: c['language.name'] })).sort((a, b) => a.value === 'en' ? -1 : b.value === 'en' ? 1 : a.value.localeCompare(b.value))

export function languageInput(value: string) {
  const tag = value || DEFAULT_LANGUAGE
  insist(catalogues.has(tag), 'unsupported_language')
  return tag
}

/** A customer language whose file was removed renders in English. */
export function customerText(language: unknown, billingCurrency='USD') {
  const tag = typeof language === 'string' && catalogues.has(language) ? language : DEFAULT_LANGUAGE
  const catalogue = catalogues.get(tag)!, intl = catalogue['language.intl']
  const t = (key: string, values: Record<string, unknown> = {}) => {
    const text = catalogue[key]
    if (text === undefined) throw new Error(`untranslated_key:${key}`)
    return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]))
  }
  // Plain text: Intl's no-break spaces become ordinary spaces in mail.
  const plain = (text: string) => text.replace(/[  ]/g, ' ')
  /** Exact cents in the invoice currency, with the locale's separators. */
  const money = (cents: number, currency = billingCurrency) => plain(new Intl.NumberFormat(intl, { style: 'currency', currency, currencyDisplay: 'code' }).format(cents / 100))
  /** An exact decimal price (up to six places, e.g. a unit-price override) in the currency, never rounded to cents. */
  const amount = (value: string, currency = billingCurrency) => plain(new Intl.NumberFormat(intl, { style: 'currency', currency, currencyDisplay: 'code', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value as unknown as number))
  /** A business-local calendar day (YYYY-MM-DD) as the locale's long date, no zone shift. */
  const day = (ymd: string) => plain(new Intl.DateTimeFormat(intl, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${ymd}T00:00:00Z`)))
  const percent = (value: unknown) => plain(new Intl.NumberFormat(intl, { maximumFractionDigits: 6 }).format(String(value) as unknown as number))
  return { tag, t, money, amount, day, percent }
}
export type CustomerText = ReturnType<typeof customerText>
