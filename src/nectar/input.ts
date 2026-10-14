// One reader over the two public doors: HTML form posts and JSON API bodies.
import { NectarError, insist } from './core'

export class Input {
  private constructor(private readonly values: Record<string, unknown>, private readonly form: FormData | null) {}

  static async from(request: Request): Promise<Input> {
    const type = request.headers.get('content-type') ?? ''
    if (type.startsWith('application/json')) {
      let body: unknown
      try { body = await request.json() } catch { insist(false, 'invalid_json') }
      insist(body && typeof body === 'object' && !Array.isArray(body), 'invalid_json')
      return new Input(body as Record<string, unknown>, null)
    }
    insist(type.startsWith('multipart/form-data') || type.startsWith('application/x-www-form-urlencoded'), 'unsupported_content_type', 415)
    return new Input({}, await request.formData())
  }

  static of(values: Record<string, unknown>) {
    return new Input(values, null)
  }

  private raw(name: string): unknown {
    if (this.form) {
      const value = this.form.get(name)
      return value === null ? undefined : value
    }
    return this.values[name]
  }

  only(names: string[]) {
    const keys = this.form ? [...this.form.keys()] : Object.keys(this.values)
    insist(keys.every(key => names.includes(key)), 'unexpected_input')
  }

  has(name: string) {
    const value = this.raw(name)
    return value !== undefined && value !== null && value !== ''
  }

  text(name: string, { max = 200, optional = false } = {}): string {
    const value = this.raw(name)
    if ((value === undefined || value === null || value === '') && optional) return ''
    insist(typeof value === 'string', `missing_${name}`)
    const trimmed = value.trim()
    insist(optional || trimmed.length > 0, `missing_${name}`)
    insist(trimmed.length <= max, `too_long_${name}`)
    return trimmed
  }

  integer(name: string, { min = 0, max = 100_000, optional = false } = {}): number | null {
    const value = this.raw(name)
    if ((value === undefined || value === null || value === '') && optional) return null
    const number = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : NaN
    insist(Number.isSafeInteger(number) && number >= min && number <= max, `invalid_${name}`)
    return number
  }

  /** Repeated values; keepEmpty preserves positions for parallel form columns. */
  list(name: string, { keepEmpty = false } = {}): string[] {
    const values = this.form ? this.form.getAll(name) : this.values[name] === undefined ? [] : this.values[name]
    insist(Array.isArray(values) && values.every(value => typeof value === 'string'), `invalid_${name}`)
    const trimmed = (values as string[]).map(value => value.trim())
    return keepEmpty ? trimmed : trimmed.filter(Boolean)
  }

  /** A structured value: a JSON body field, or a JSON-encoded form field. */
  json(name: string): unknown {
    const value = this.raw(name)
    if (!this.form) return value
    insist(typeof value === 'string' && value.length <= 500_000, `missing_${name}`)
    try { return JSON.parse(value) } catch { throw new NectarError(`invalid_${name}`) }
  }

  flag(name: string): boolean {
    const value = this.raw(name)
    return value === true || value === 'yes' || value === 'on' || value === 'true'
  }

  /** A file from a multipart form, or base64 bytes plus filename from JSON. */
  async file(name: string, { optional = false, maxBytes = 8_000_000 } = {}): Promise<{ filename: string; bytes: Uint8Array; declaredType: string } | null> {
    if (this.form) {
      const value = this.form.get(name)
      if ((!value || (typeof value !== 'string' && value.size === 0)) && optional) return null
      insist(value && typeof value !== 'string', `missing_${name}`)
      insist(value.size > 0 && value.size <= maxBytes, 'file_size')
      return { filename: cleanFilename(value.name), bytes: new Uint8Array(await value.arrayBuffer()), declaredType: value.type }
    }
    const value = this.values[name] as { filename?: unknown; base64?: unknown; type?: unknown } | undefined
    if (!value && optional) return null
    insist(value && typeof value.filename === 'string' && typeof value.base64 === 'string', `missing_${name}`)
    insist(value.base64.length <= Math.ceil(maxBytes / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(value.base64), 'invalid_base64')
    const bytes = Uint8Array.from(atob(value.base64), character => character.charCodeAt(0))
    insist(bytes.length > 0 && bytes.length <= maxBytes, 'file_size')
    return { filename: cleanFilename(value.filename), bytes, declaredType: typeof value.type === 'string' ? value.type : '' }
  }
}

function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop()?.replace(/[\x00-\x1f]/g, '').trim() ?? ''
  insist(base.length > 0 && base.length <= 200, 'invalid_filename')
  return base
}
