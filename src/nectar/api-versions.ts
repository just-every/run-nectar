// DEV-002: dated API versions. Handlers always build the latest shape; a
// request answered under an earlier version has each later change undone, newest
// first. A credential is pinned to a version; a Nectar-Version header overrides
// it for one call; a member's session uses the header or the latest version.
import type { Actor } from './actor'
import { insist } from './core'

interface Change { version: string; summary: string; downgrade: (body: unknown) => unknown }

const renameCursor = (body: unknown) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('next_cursor' in body)) return body
  const { next_cursor, ...rest } = body as Record<string, unknown>
  return { ...rest, nextCursor: next_cursor }
}

export const ORIGINAL_VERSION = '2026-10-01'

/** Every change after the original version, oldest first. */
export const CHANGES: Change[] = [
  { version: '2026-10-20', summary: 'List pages name their continuation `next_cursor` (was `nextCursor`).', downgrade: renameCursor },
]

export const VERSIONS = [ORIGINAL_VERSION, ...CHANGES.map(change => change.version)]
export const LATEST_VERSION = VERSIONS[VERSIONS.length - 1]

export function checkVersion(value: string) {
  insist(VERSIONS.includes(value), 'unknown_api_version', 400, { versions: VERSIONS })
  return value
}

export function requestVersion(actor: Actor, request: Request) {
  const header = request.headers.get('nectar-version')
  if (header !== null) return checkVersion(header.trim())
  return actor.apiVersion ?? LATEST_VERSION
}

/** The latest-shape body as the given version names it. */
export function present(version: string, body: unknown) {
  return CHANGES.filter(change => change.version > version).reverse().reduce((value, change) => change.downgrade(value), body)
}
