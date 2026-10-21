// Calendar dates (YYYY-MM-DD) in the business's billing timezone, and the
// subscription periods they form. A period is [start, end): it starts at
// local midnight on its start date and ends at local midnight on its end date.
import { insist } from './core'

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
export const isDate = (text: unknown): text is string => {
  if (typeof text !== 'string' || !DATE.test(text)) return false
  const date = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text
}

export function requireDate(text: string, field: string): string {
  insist(isDate(text), `invalid_${field}`)
  return text
}

const utc = (date: string) => Date.parse(`${date}T00:00:00Z`)
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
export const addDays = (date: string, days: number) => iso(utc(date) + days * 86_400_000)
export const daysBetween = (from: string, to: string) => Math.round((utc(to) - utc(from)) / 86_400_000)

/** The same day-of-month `months` later (anchor days are 1–28, so the day always exists). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const index = y * 12 + (m - 1) + months
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Preserve the original contractual day, clamping only the target month.
 * Call with the original anchor for every boundary: Jan31, Feb28, Mar31. */
export function addMonthsClamped(date: string, months: number): string {
  insist(isDate(date) && Number.isSafeInteger(months), 'invalid_calendar_date')
  const [year, month, day] = date.split('-').map(Number), index = year * 12 + month - 1 + months
  const targetYear = Math.floor(index / 12), targetMonth = ((index % 12) + 12) % 12 + 1
  insist(targetYear >= 1 && targetYear <= 9999, 'billing_calendar_out_of_range')
  const first = `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}-01`
  const next = new Date(`${first}T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1); next.setUTCDate(0)
  return `${first.slice(0, 8)}${String(Math.min(day, next.getUTCDate())).padStart(2, '0')}`
}

export function validTimeZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(zone) } catch { return false }
}

const parts = (ms: number, zone: string) => {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]))
  return values as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>
}

/** The local calendar date of an instant in the zone. */
export function localDate(ms: number, zone: string): string {
  const p = parts(ms, zone)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

const offset = (ms: number, zone: string) => {
  const p = parts(ms, zone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
}

/** The instant of local midnight at the start of `date` in the zone. */
export function zonedStart(date: string, zone: string): number {
  const guess = utc(date)
  let instant = guess - offset(guess, zone)
  instant = guess - offset(instant, zone)
  return instant
}

export const today = (zone: string, instant=Date.now()) => localDate(instant, zone)

/** An ISO 8601 instant with an explicit offset (or Z); naive local times are refused. */
export function parseInstant(text: string, field = 'occurred_at'): number {
  const value = String(text ?? '').trim()
  insist(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(value), `invalid_${field}`)
  const ms = Date.parse(value)
  insist(Number.isFinite(ms) && isDate(value.slice(0, 10)), `invalid_${field}`)
  return ms
}

/** The billing period of a subscription with this anchor day that contains `date`. */
export function periodContaining(anchorDay: number, date: string): { start: string; end: string } {
  const [y, m, d] = date.split('-').map(Number)
  let start = `${y}-${String(m).padStart(2, '0')}-${String(anchorDay).padStart(2, '0')}`
  if (d < anchorDay) start = addMonths(start, -1)
  return { start, end: addMonths(start, 1) }
}

/** The billing period of a subscription that starts within calendar month `month` (YYYY-MM). */
export const periodStartingIn = (anchorDay: number, month: string) => {
  const start = `${month}-${String(anchorDay).padStart(2, '0')}`
  return { start, end: addMonths(start, 1) }
}

export const isMonth = (text: unknown): text is string => typeof text === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(text)

/** An instant in the zone, with the zone's short name ("Oct 14, 2026, 11:14 AM PDT"). */
export function formatInstant(ms: number, zone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ms))
}

export function formatDate(date: string | null | undefined): string {
  if (!date) return '—'
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'medium' }).format(new Date(`${date}T00:00:00Z`))
}

/** A [start, end) period as people read it: the last day it covers, the year once ("Jul 1 – Jul 31, 2026").
 * Each date keeps its words together, so a narrow cell breaks only after the dash. */
export function formatPeriod(start: string | null | undefined, endExclusive: string | null | undefined): string {
  if (!start || !endExclusive) return '—'
  const last = addDays(endExclusive, -1)
  const whole = (text: string) => text.replace(/ /g, '\u00a0')
  if (last <= start) return whole(formatDate(start))
  if (start.slice(0, 4) !== last.slice(0, 4)) return `${whole(formatDate(start))} – ${whole(formatDate(last))}`
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${start}T00:00:00Z`))
  return `${whole(day)} – ${whole(formatDate(last))}`
}
