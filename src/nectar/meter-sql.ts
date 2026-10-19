// Caller SQL is tokenized and parsed into a closed metric plan. It is never sent to D1.
import { NectarError, insist } from './core'
import { parseRational, type Expression, type MetricPlan, type Operand, type Predicate } from './metric-plan'
export { matches, numericValue, propertyIdentity } from './metric-plan'

interface Token { kind: 'word' | 'number' | 'string' | 'symbol' | 'end'; text: string; at: number }
function invalid(at: number): never { throw new NectarError('invalid_meter_sql', 400, { position: at }) }

function tokenize(sql: string): Token[] {
  insist(typeof sql === 'string' && sql.length > 0 && sql.length <= 16_000, 'invalid_meter_sql')
  const tokens: Token[] = []
  for (let at = 0; at < sql.length;) {
    const char = sql[at], start = at
    if (/\s/.test(char)) { at++; continue }
    if (char === "'") {
      let text = '', closed = false
      at++
      while (at < sql.length) {
        if (sql[at] === "'") {
          if (sql[at + 1] === "'") { text += "'"; at += 2; continue }
          at++; closed = true; break
        }
        text += sql[at++]
      }
      if (!closed) invalid(start)
      tokens.push({ kind: 'string', text, at: start })
    } else if (/[A-Za-z_]/.test(char)) {
      at++
      while (at < sql.length && /[A-Za-z0-9_]/.test(sql[at])) at++
      tokens.push({ kind: 'word', text: sql.slice(start, at), at: start })
    } else if (/\d/.test(char)) {
      at++
      while (at < sql.length && /\d/.test(sql[at])) at++
      if (sql[at] === '.') {
        at++
        if (!/\d/.test(sql[at] ?? '')) invalid(at)
        while (at < sql.length && /\d/.test(sql[at])) at++
      }
      const text = sql.slice(start, at)
      if (!/^\d{1,18}(?:\.\d{1,6})?$/.test(text)) invalid(start)
      tokens.push({ kind: 'number', text, at: start })
    } else {
      // Refuse SQL comments rather than interpreting their contents as operators.
      if (sql.startsWith('--', at) || sql.startsWith('/*', at) || sql.startsWith('*/', at)) invalid(at)
      const pair = sql.slice(at, at + 2)
      if (['!=', '<=', '>='].includes(pair)) { tokens.push({ kind: 'symbol', text: pair, at }); at += 2 }
      else if ('(),.+-*/=<>;'.includes(char)) { tokens.push({ kind: 'symbol', text: char, at }); at++ }
      else invalid(at)
    }
    if (tokens.length > 2000) invalid(at)
  }
  tokens.push({ kind: 'end', text: '', at: sql.length })
  return tokens
}

class Parser {
  private index = 0
  private depth = 0
  constructor(private readonly tokens: Token[]) {}
  private peek() { return this.tokens[this.index] }
  private has(text: string) { return this.peek().kind !== 'string' && this.peek().text.toUpperCase() === text }
  private eat(text: string) { if (!this.has(text)) return false; this.index++; return true }
  private need(text: string) { if (!this.eat(text)) invalid(this.peek().at) }
  private nested<T>(parse: () => T): T {
    if (++this.depth > 48) invalid(this.peek().at)
    try { return parse() } finally { this.depth-- }
  }
  private property(): string {
    this.need('PROPERTIES'); this.need('.')
    const token = this.peek()
    if (token.kind !== 'word') invalid(token.at)
    this.index++
    return token.text
  }
  parse(): MetricPlan {
    this.need('SELECT')
    const projected: string[] = []
    let plan: MetricPlan | undefined
    do {
      if (this.has('PROPERTIES')) projected.push(this.property())
      else {
        if (plan) invalid(this.peek().at)
        plan = this.aggregate()
        if (this.eat('AS')) {
          const alias = this.peek()
          if (alias.kind !== 'word' || ['FROM', 'WHERE', 'GROUP', 'SELECT'].includes(alias.text.toUpperCase())) invalid(alias.at)
          this.index++
        }
      }
    } while (this.eat(','))
    if (!plan) invalid(this.peek().at)
    this.need('FROM'); this.need('USAGE_EVENTS')
    if (this.eat('WHERE')) plan.where = this.predicate()
    if (this.eat('GROUP')) {
      this.need('BY')
      do { plan.groupBy.push(this.property()) } while (this.eat(','))
    }
    this.eat(';')
    if (this.peek().kind !== 'end') invalid(this.peek().at)
    if (new Set(projected).size !== projected.length || new Set(plan.groupBy).size !== plan.groupBy.length || projected.length !== plan.groupBy.length || projected.some(name => !plan.groupBy.includes(name))) invalid(0)
    return plan
  }
  private aggregate(): MetricPlan {
    const token = this.peek(), name = token.text.toUpperCase()
    if (token.kind !== 'word' || !['SUM', 'COUNT', 'MAX', 'LATEST', 'TIME_WEIGHTED'].includes(name)) invalid(token.at)
    this.index++; this.need('(')
    const plan: MetricPlan = { aggregation: 'sum', value: { kind: 'quantity' }, groupBy: [] }
    if (name === 'COUNT') {
      if (this.eat('*')) plan.aggregation = 'count'
      else { this.need('DISTINCT'); plan.uniqueProperty = this.property(); plan.aggregation = 'unique' }
    } else if (name === 'LATEST' || name === 'TIME_WEIGHTED') {
      this.need('QUANTITY')
      plan.aggregation = name === 'LATEST' ? 'latest' : 'time_weighted'
      if (name === 'TIME_WEIGHTED') {
        this.need(',')
        const unit = this.peek()
        if (unit.kind !== 'string' || (unit.text !== 'hour' && unit.text !== 'month')) invalid(unit.at)
        plan.timeUnit = unit.text; this.index++
        if(this.eat(',')) plan.entityProperty=this.property()
      }
    } else {
      plan.aggregation = name === 'SUM' ? 'sum' : 'maximum'
      plan.value = this.expression(name === 'SUM')
    }
    this.need(')')
    return plan
  }
  private expression(allowCase = false): Expression {
    let value = this.product(allowCase)
    while (this.has('+') || this.has('-')) {
      const operator = this.peek().text as '+' | '-'; this.index++
      value = { kind: 'binary', operator, left: value, right: this.product(allowCase) }
    }
    return value
  }
  private product(allowCase: boolean): Expression {
    let value = this.atom(allowCase)
    while (this.has('*') || this.has('/')) {
      const operator = this.peek().text as '*' | '/'; this.index++
      value = { kind: 'binary', operator, left: value, right: this.atom(allowCase) }
    }
    return value
  }
  private atom(allowCase: boolean): Expression {
    return this.nested<Expression>(() => {
      if (this.eat('-')) return { kind: 'negate', value: this.atom(allowCase) }
      if (this.eat('+')) return this.atom(allowCase)
      if (this.eat('(')) { const value = this.expression(allowCase); this.need(')'); return value }
      if (this.eat('QUANTITY')) return { kind: 'quantity' }
      if (this.has('PROPERTIES')) return { kind: 'property', name: this.property() }
      if (allowCase && this.eat('CASE')) {
        const branches: { when: Predicate; then: Expression }[] = []
        do {
          this.need('WHEN'); const when = this.predicate(); this.need('THEN')
          branches.push({ when, then: this.expression(true) })
        } while (this.has('WHEN'))
        this.need('ELSE'); const otherwise = this.expression(true); this.need('END')
        return { kind: 'case', branches, otherwise }
      }
      const token = this.peek()
      if (token.kind !== 'number') invalid(token.at)
      this.index++; parseRational(token.text)
      return { kind: 'number', value: token.text }
    })
  }
  private operand(): Operand {
    const token = this.peek()
    if (token.kind === 'string') { this.index++; return { kind: 'literal', value: token.text } }
    if (this.eat('NULL')) return { kind: 'literal', value: null }
    if (this.eat('TRUE')) return { kind: 'literal', value: true }
    if (this.eat('FALSE')) return { kind: 'literal', value: false }
    return this.expression()
  }
  private predicate(): Predicate {
    let value = this.conjunction()
    while (this.eat('OR')) value = { kind: 'or', left: value, right: this.conjunction() }
    return value
  }
  private conjunction(): Predicate {
    let value = this.condition()
    while (this.eat('AND')) value = { kind: 'and', left: value, right: this.condition() }
    return value
  }
  private opensPredicate(): boolean {
    if (!this.has('(')) return false
    let depth = 0
    for (let at = this.index; at < this.tokens.length; at++) {
      const token = this.tokens[at]
      if (token.kind !== 'symbol') continue
      if (token.text === '(') depth++
      if (token.text !== ')' || --depth !== 0) continue
      const next = this.tokens[at + 1]
      return !next || next.kind === 'end' || !['+', '-', '*', '/', '=', '!=', '<', '<=', '>', '>=', 'IN', 'NOT'].includes(next.text.toUpperCase())
    }
    invalid(this.peek().at)
  }
  private condition(): Predicate {
    return this.nested<Predicate>(() => {
      if (this.eat('NOT')) return { kind: 'not', value: this.condition() }
      if (this.opensPredicate()) {
        // Decide once from the closing token, without speculative recursive parsing.
        this.need('(')
        const value = this.predicate(); this.need(')'); return value
      }
      const left = this.operand(), negated = this.eat('NOT')
      if (this.eat('IN')) {
        this.need('(')
        const values: Operand[] = []
        do {
          const value = this.operand()
          if (value.kind !== 'literal' && value.kind !== 'number' && !(value.kind === 'negate' && value.value.kind === 'number')) invalid(this.peek().at)
          values.push(value)
        } while (this.eat(','))
        this.need(')')
        return { kind: 'in', value: left, values, negated }
      }
      if (negated) invalid(this.peek().at)
      const token = this.peek()
      if (token.kind !== 'symbol' || !['=', '!=', '<', '<=', '>', '>='].includes(token.text)) invalid(token.at)
      this.index++
      return { kind: 'compare', operator: token.text as '=' | '!=' | '<' | '<=' | '>' | '>=', left, right: this.operand() }
    })
  }
}

/** SELECT grouping keys plus exactly one aggregate, from usage_events only. */
export const parseMeterSql = (sql: string): MetricPlan => new Parser(tokenize(sql)).parse()
