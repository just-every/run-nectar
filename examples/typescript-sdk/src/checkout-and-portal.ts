import type { NectarClient, PaymentLink, PortalSession } from '../../../sdks/typescript/src/index.js'

export interface ExistingCheckoutInput {
  /** Installation origin or native API root; only its origin is used. */
  baseUrl: string
  link: string
  /** Explicit invocation by an owner; native API authority remains authoritative. */
  ownerInvoked: true
}
export interface HostedPortalInput {
  customer: string
  origin: string
  ownerInvoked: true
  idempotencyKey: string
}

/** Resolve only a native relative checkout path, never a supplied external URL. */
export function resolveCheckoutUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new TypeError('Checkout base must be an HTTP installation URL without credentials or query')
  }
  if (!/^\/pay-links\/[A-Za-z0-9_-]+$/.test(path)) {
    throw new TypeError('Expected a native relative payment-link path')
  }
  return new URL(path, base.origin).href
}

/** Server-only: read an existing approved link and return its customer entry URL. */
export async function openExistingCheckout(client: NectarClient, input: ExistingCheckoutInput): Promise<{ link: PaymentLink; url: string }> {
  if (input.ownerInvoked !== true) throw new TypeError('An explicit owner invocation is required')
  const links = await client.paymentLinks.list()
  const link = links.find(candidate => candidate.id === input.link)
  if (!link || link.status !== 'active' || link.approvalStatus !== 'approved' || !link.activated) {
    throw new Error('The selected native checkout link is not active, approved and activated')
  }
  if (link.path !== `/pay-links/${link.id}`) throw new Error('The native checkout link path does not match its identity')
  return { link, url: resolveCheckoutUrl(input.baseUrl, link.path) }
}

/** Server-only owner action: return a private capability for an approved hosted origin. */
export async function issueHostedPortal(client: NectarClient, input: HostedPortalInput): Promise<PortalSession> {
  if (input.ownerInvoked !== true) throw new TypeError('An explicit owner invocation is required')
  return client.portal.sessions.issue({ customer: input.customer, origin: input.origin, audience: 'hosted' },
    { idempotencyKey: input.idempotencyKey })
}
