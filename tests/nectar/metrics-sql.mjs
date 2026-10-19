import assert from 'node:assert/strict'

export async function metricsSql(h, owner, fixture) {
  const { source, customer, months, checkPreview, expected } = fixture
  const where = "WHERE properties.active = true GROUP BY properties.model"
  const cases = [
    ['sum', `SELECT properties.model, SUM(CASE WHEN properties.weight >= 1 THEN quantity * properties.weight / 2 ELSE (quantity + 2) / 4 END) AS quantity FROM usage_events WHERE properties.model IN ('alpha','beta') AND NOT properties.active != true AND (quantity >= 1 OR properties.user = 'never') AND properties.weight <= 3 AND properties.weight > 0 AND quantity < 10000 GROUP BY properties.model`, [[[6,1],[5,1]],[[8,1],[7,2]],[[3,4],[3,1]]]],
    ['count', `SELECT properties.model, COUNT(*) AS quantity FROM usage_events ${where}`],
    ['maximum', `SELECT properties.model, MAX(quantity) AS quantity FROM usage_events ${where}`],
    ['unique', `SELECT properties.model, COUNT(DISTINCT properties.user) AS quantity FROM usage_events ${where}`],
    ['latest', `SELECT properties.model, LATEST(quantity) AS quantity FROM usage_events ${where}`],
    ['time_weighted', `SELECT properties.model, TIME_WEIGHTED(quantity,'month',properties.resource) AS quantity FROM usage_events ${where}`],
  ]
  const meters = []
  for (const [aggregation, sql, values] of cases) {
    const prepared = await h.api('meter.prepare', owner, { code: `use002-sql-${aggregation}`, name: `USE002 SQL ${aggregation}`, unit_label: 'units', source_meter: source.id, sql })
    for (const [index, period] of months.entries()) {
      const preview = await h.api('meter.preview', owner, { request: prepared.request, customer, period })
      checkPreview(preview, values ? values[index] : expected[aggregation][index], `SQL ${aggregation} ${period}`)
    }
    const meter = await h.api('meter.activate', owner, { request: prepared.request })
    assert.ok(meter.id, `USE-002 SQL ${aggregation} activates only after three independent period previews`)
    meters.push(meter)
  }
  for (const [index, sql] of [
    'DELETE FROM usage_events',
    'SELECT SUM(quantity) AS quantity FROM usage_events; DROP TABLE nc_customers',
    'SELECT SUM(quantity) AS quantity FROM usage_events JOIN nc_customers ON 1=1',
    'SELECT SUM(quantity) AS quantity FROM sqlite_master',
    'SELECT SUM(quantity) AS quantity FROM main.usage_events',
  ].entries()) await h.api('meter.prepare', owner, { code: `use002-unsafe-${index}`, name: 'Unsafe metric', unit_label: 'units', source_meter: source.id, sql }, 400)
  return meters
}
