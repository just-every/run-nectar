import type { Bindings } from '../auth.server'

// Fieldnote Software's customer book, as the homepage and the app look follow it:
// key, customer id, name, accounts-payable contact, seats, API calls a month, address.
export const customers = [
  ['lakeview', 'LF-1001', 'Lakeview Freight', 'Tom Reyes', 48, 1200000, '1200 Leavenworth St, Omaha, NE 68102'],
  ['mesa', 'MS-1002', 'Mesa Solar', 'Ana Ortiz', 10, 180000, '400 E Van Buren St, Phoenix, AZ 85004'],
  ['cedarpine', 'CP-1003', 'Cedar & Pine', 'Priya Nair', 36, 760000, '1420 5th Ave, Seattle, WA 98101'],
  ['lumen', 'LH-1004', 'Lumen Health', 'Grace Kim', 60, 780000, '920 SW 6th Ave, Portland, OR 97204'],
  ['summit', 'SO-1005', 'Summit Outfitters', 'Jake Morrow', 42, 720000, '1300 Pearl St, Boulder, CO 80302'],
  ['birchwood', 'BL-1006', 'Birchwood Legal', 'Owen Hart', 6, 110000, '600 Congress Ave, Austin, TX 78701'],
] as const

// Fieldnote's finance operator and metering pipeline do the routine work; the owner approves.
export const finance = 'marcus@fieldnote.example', pipeline = 'agent:Metering pipeline'

export const products = [
  ['seats', 'Seats', 'seat', '95.00', 'Team seats, billed monthly'],
  ['api', 'API calls', 'unit', '0.0019', 'Metered API calls'],
] as const

/** Fixed primary keys and no updates: rerunning the hook preserves visitor edits. */
export function insert(env: Bindings, table: string, values: Record<string, unknown>) {
  const columns = Object.keys(values)
  return env.DB.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT DO NOTHING`).bind(...Object.values(values))
}
