// PORT-006: a translation file is complete only when it has exactly en.json's
// keys, no empty value, and the same {placeholders} in every string.
export type Catalogue = Record<string, string>

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',')

export function catalogueProblems(base: Catalogue, other: Catalogue): string[] {
  const problems: string[] = []
  for (const key of Object.keys(base)) {
    if (!(key in other)) problems.push(`missing ${key}`)
    else if (typeof other[key] !== 'string' || !other[key].trim()) problems.push(`empty ${key}`)
    else if (placeholders(other[key]) !== placeholders(base[key])) problems.push(`placeholders ${key}`)
  }
  for (const key of Object.keys(other)) if (!(key in base)) problems.push(`extra ${key}`)
  return problems
}
