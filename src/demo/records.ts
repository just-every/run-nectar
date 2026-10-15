import type { Bindings } from '../auth.server'

// The acceptance examples, expanded into an invented B2B customer book.
export const customers = [
  ['northwind', 'NW-1001', 'Northwind Robotics', 'Ada Chen', 5, 1250000],
  ['pinecrest', 'PC-2002', 'Pinecrest Labs', 'Jonah Miller', 3, 680000],
  ['harbor', 'HB-1003', 'Harbor Logistics', 'Maya Patel', 12, 2840000],
  ['juniper', 'JN-1004', 'Juniper Analytics', 'Elliot Brooks', 8, 1920000],
  ['cedar', 'CD-1005', 'Cedar Health Systems', 'Sofia Reyes', 16, 3200000],
  ['atlas', 'AT-1006', 'Atlas Field Services', 'Noah Williams', 4, 920000],
] as const

// Riverbend's finance operator and metering pipeline do the routine work; the owner approves.
export const finance = 'marcus@riverbend.example', pipeline = 'agent:Metering pipeline'

export const products = [
  ['core', 'Core plan', 'flat', '499.00', 'Workspace, reporting and monthly billing'],
  ['seats', 'Team seats', 'seat', '30.00', 'Additional team members'],
  ['events', 'Event processing', 'unit', '0.0004', 'Metered API events'],
] as const

/** Fixed primary keys and no updates: rerunning the hook preserves visitor edits. */
export function insert(env: Bindings, table: string, values: Record<string, unknown>) {
  const columns = Object.keys(values)
  return env.DB.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT DO NOTHING`).bind(...Object.values(values))
}
