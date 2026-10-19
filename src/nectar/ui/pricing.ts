// Catalogue input and readable invoice evidence for immutable quantity prices.
import { dimensionFields } from './meters'
import type { Row } from '../core'
import { check, field, form, h, hidden, select, table } from './html'

export function quantityPriceForm(product: string, meters: Row[], initial = false) {
  return h`<details><summary>${initial ? 'Add a tiered price version' : 'Prepare a tiered price version'}</summary><p class="hint">Enter bands in order. Leave the final band's upper quantity blank for no limit. Package pricing uses one band and a block size. Zero units have no charge; fees apply once per occupied band.</p>
    ${form('price.create', '/app/catalog', h`${hidden('product', product)}${select('Kind', 'kind', [{ value: 'seat', label: 'Per seat monthly' }, { value: 'unit', label: 'Metered usage' }])}
      ${select('Pricing model', 'pricing_model', [{ value: 'graduated', label: 'Graduated: each band at its rate' }, { value: 'volume', label: 'Volume: all units at the band reached' }, { value: 'package', label: 'Package: round up to whole blocks' }, { value: 'stair_step', label: 'Stair-step: flat fee for the band reached' }])}
      ${select('Meter (usage only)', 'meter', meters.map(m => ({ value: m.id, label: m.code })), '', { required: false, blank: '—' })}
      ${dimensionFields()}${field('Block size (package only)', 'package_size', { required: false })}${field('Name for this price', 'nickname', { required: false })}
      ${[1, 2, 3, 4].map(tier => h`<fieldset><legend>Band ${tier}</legend>${field('Upper quantity (blank means no limit)', 'tier_limit', { required: false })}${field('Unit price or price per block ($)', 'tier_unit_amount', { required: false })}${field('Flat fee ($; required for stair-step)', 'tier_flat_amount', { required: false })}</fieldset>`)}
      ${check('Taxable', 'taxable', { checked: true })}`, initial ? 'Add tiered price version' : 'Prepare tiered price version', { layout: 'columns', secondary: true })}</details>`
}

export function pricingTiers(pricing: Row) {
  return h`<details><summary>Pricing tiers</summary>${pricing.packageSize ? h`<p>Block size: ${pricing.packageSize} units, rounded up.</p>` : ''}${table(['From (exclusive)', 'Through (inclusive)', 'Unit price$', 'Flat fee$'], pricing.tiers.map((t: Row, i: number) => [i ? pricing.tiers[i - 1].upTo : '0', t.upTo ?? 'No limit', `$${t.unitAmount}`, `$${t.flatAmount}`]))}</details>`
}

export function linePricing(line: Row) {
  const evidence = line.evidence
  if (!evidence.pricingModel) return ''
  return h`<details><summary>Tier calculation</summary>${evidence.tiers.length ? h`<ul>${evidence.tiers.map((t: Row) => h`<li><strong>${t.upTo === null ? `Above ${t.fromExclusive} units` : `Above ${t.fromExclusive} through ${t.upTo} units`}</strong><p>${t.blocks ? `${t.blocks} blocks of ${t.packageSize}` : `${t.quantity} units`} × $${t.unitAmount}, plus $${t.flatAmount} fee = $${t.amountExact} exact.</p></li>`)}</ul>` : h`<p>Zero units: no band or fee activated.</p>`}<p>Exact amount before proration and line rounding: $${evidence.amountExact}. Billed ${evidence.days} of ${evidence.periodDays} days.</p></details>`
}

export function priceRate(price: Row) {
  if (price.pricing_model && price.pricing_model !== 'simple') return `${price.pricing_model.replace('_', '-')} pricing`
  return `$${price.unit_amount}${price.kind === 'seat' ? ' per seat' : price.kind === 'unit' ? ` per ${price.unit_label ?? price.meter_code ?? 'unit'}` : ''}`
}
