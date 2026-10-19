import { insist } from './core'

export type PropertyValue = string | number | boolean | null
export interface MetricEvent { eventId: string; quantity: string; occurredAt: number; properties: Record<string, PropertyValue> }
export interface Rational { n: bigint; d: bigint }
export type Expression =
  | { kind: 'number'; value: string }
  | { kind: 'quantity' }
  | { kind: 'property'; name: string }
  | { kind: 'binary'; operator: '+' | '-' | '*' | '/'; left: Expression; right: Expression }
  | { kind: 'negate'; value: Expression }
  | { kind: 'case'; branches: { when: Predicate; then: Expression }[]; otherwise: Expression }
export type Literal = { kind: 'literal'; value: PropertyValue }
export type Operand = Expression | Literal
export type Predicate =
  | { kind: 'compare'; operator: '=' | '!=' | '<' | '<=' | '>' | '>='; left: Operand; right: Operand }
  | { kind: 'in'; value: Operand; values: Operand[]; negated: boolean }
  | { kind: 'and' | 'or'; left: Predicate; right: Predicate }
  | { kind: 'not'; value: Predicate }
export interface MetricPlan {
  aggregation: 'sum' | 'count' | 'maximum' | 'unique' | 'latest' | 'time_weighted'
  value: Expression
  where?: Predicate
  groupBy: string[]
  uniqueProperty?: string
  entityProperty?: string
  timeUnit?: 'hour' | 'month'
}

export function rational(n: bigint, d = 1n): Rational {
  insist(d !== 0n, 'metric_division_by_zero')
  if (d < 0n) { n = -n; d = -d }
  let a = n < 0n ? -n : n, b = d
  while (b) { const rest = a % b; a = b; b = rest }
  return { n: n / a, d: d / a }
}

/** JSON numeric properties are canonicalized once to six places; all subsequent arithmetic is integer arithmetic. */
export function parseRational(value: string | number, field = 'metric_number'): Rational {
  if (typeof value === 'number') insist(Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER, `invalid_${field}`)
  const text = typeof value === 'number' ? value.toFixed(6) : value
  insist(/^-?\d{1,18}(?:\.\d{1,6})?$/.test(text), `invalid_${field}`)
  const negative = text.startsWith('-'), [whole, fraction = ''] = text.replace(/^-/, '').split('.')
  const d = 10n ** BigInt(fraction.length)
  return rational((BigInt(whole) * d + BigInt(fraction || '0')) * (negative ? -1n : 1n), d)
}

export const addRational = (a: Rational, b: Rational) => rational(a.n * b.d + b.n * a.d, a.d * b.d)
export const subtractRational = (a: Rational, b: Rational) => rational(a.n * b.d - b.n * a.d, a.d * b.d)
export const multiplyRational = (a: Rational, b: Rational) => rational(a.n * b.n, a.d * b.d)
export const divideRational = (a: Rational, b: Rational) => rational(a.n * b.d, a.d * b.n)
export const compareRational = (a: Rational, b: Rational): number => {
  const delta = a.n * b.d - b.n * a.d
  return delta < 0n ? -1 : delta > 0n ? 1 : 0
}

export function propertyValue(event: MetricEvent, name: string): PropertyValue | undefined {
  return Object.hasOwn(event.properties, name) ? event.properties[name] : undefined
}

/** Type-aware identities keep a numeric user id distinct from the same textual id, and missing distinct from null. */
export function propertyIdentity(value: PropertyValue | undefined): string {
  if (value === undefined) return 'missing'
  if (value === null) return 'null'
  if (typeof value === 'number') { const number = parseRational(value); return `number:${number.n}/${number.d}` }
  return `${typeof value}:${JSON.stringify(value)}`
}

/** A missing, null or nonnumeric property in a selected arithmetic expression is a data error, never silently zero. */
export function numericValue(expression: Expression, event: MetricEvent): Rational {
  switch (expression.kind) {
    case 'number': return parseRational(expression.value)
    case 'quantity': return parseRational(event.quantity, 'quantity')
    case 'property': {
      const value = propertyValue(event, expression.name)
      insist(typeof value === 'string' || typeof value === 'number', 'invalid_metric_property', 400, expression.name)
      return parseRational(value, 'metric_property')
    }
    case 'negate': { const value = numericValue(expression.value, event); return { n: -value.n, d: value.d } }
    case 'binary': {
      const left = numericValue(expression.left, event), right = numericValue(expression.right, event)
      switch (expression.operator) {
        case '+': return addRational(left, right)
        case '-': return subtractRational(left, right)
        case '*': return multiplyRational(left, right)
        case '/': return divideRational(left, right)
      }
    }
    case 'case': {
      const branch = expression.branches.find(branch => matches(branch.when, event))
      return numericValue(branch ? branch.then : expression.otherwise, event)
    }
  }
}

type Scalar = { numeric: Rational } | { raw: PropertyValue | undefined }
type Truth = boolean | null
const isMissing = (value: Scalar) => 'raw' in value && (value.raw === null || value.raw === undefined)
function scalar(expression: Operand, event: MetricEvent): Scalar {
  if (expression.kind === 'literal') return { raw: expression.value }
  if (expression.kind === 'property') return { raw: propertyValue(event, expression.name) }
  // In a predicate, an absent numeric operand has SQL's unknown truth value.
  if (missingOperand(expression, event)) return { raw: undefined }
  return { numeric: numericValue(expression, event) }
}
function missingOperand(expression: Expression, event: MetricEvent): boolean {
  if (expression.kind === 'property') return propertyValue(event, expression.name) == null
  if (expression.kind === 'binary') return missingOperand(expression.left, event) || missingOperand(expression.right, event)
  if (expression.kind === 'negate') return missingOperand(expression.value, event)
  if (expression.kind === 'case') {
    const branch = expression.branches.find(branch => matches(branch.when, event))
    return missingOperand(branch ? branch.then : expression.otherwise, event)
  }
  return false
}
function comparison(left: Scalar, right: Scalar): number | null {
  if (isMissing(left) || isMissing(right)) return null
  if ('numeric' in left || 'numeric' in right || ('raw' in left && typeof left.raw === 'number') || ('raw' in right && typeof right.raw === 'number')) {
    const numeric = (value: Scalar): Rational | undefined => {
      if ('numeric' in value) return value.numeric
      if (typeof value.raw !== 'string' && typeof value.raw !== 'number') return undefined
      if (typeof value.raw === 'string' && !/^-?\d{1,18}(?:\.\d{1,6})?$/.test(value.raw)) return undefined
      return parseRational(value.raw, 'metric_property')
    }
    const a = numeric(left), b = numeric(right)
    return a && b ? compareRational(a, b) : null
  }
  if (!('raw' in left) || !('raw' in right) || typeof left.raw !== typeof right.raw) return null
  if (left.raw === right.raw) return 0
  if (typeof left.raw === 'string' && typeof right.raw === 'string') return left.raw < right.raw ? -1 : 1
  if (typeof left.raw === 'boolean' && typeof right.raw === 'boolean') return left.raw ? 1 : -1
  return null
}

/** Missing/null predicate operands remain unknown under NOT; only true includes an event. */
function truth(predicate: Predicate, event: MetricEvent): Truth {
  switch (predicate.kind) {
    case 'not': { const value = truth(predicate.value, event); return value === null ? null : !value }
    case 'and': {
      const left = truth(predicate.left, event)
      if (left === false) return false
      const right = truth(predicate.right, event)
      return right === false ? false : left === null || right === null ? null : true
    }
    case 'or': {
      const left = truth(predicate.left, event)
      if (left === true) return true
      const right = truth(predicate.right, event)
      return right === true ? true : left === null || right === null ? null : false
    }
    case 'compare': {
      const order = comparison(scalar(predicate.left, event), scalar(predicate.right, event))
      if (order === null) return null
      switch (predicate.operator) {
        case '=': return order === 0
        case '!=': return order !== 0
        case '<': return order < 0
        case '<=': return order <= 0
        case '>': return order > 0
        case '>=': return order >= 0
      }
    }
    case 'in': {
      const value = scalar(predicate.value, event)
      let unknown = false
      for (const item of predicate.values) {
        const order = comparison(value, scalar(item, event))
        if (order === 0) return !predicate.negated
        if (order === null) unknown = true
      }
      return unknown ? null : predicate.negated
    }
  }
}

export const matches = (predicate: Predicate | undefined, event: MetricEvent): boolean => !predicate || truth(predicate, event) === true
