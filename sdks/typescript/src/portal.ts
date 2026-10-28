import type { NectarTransport, WriteOptions } from './transport.js'

interface PortalSessionIssueBase {
  /** Existing internal Nectar customer ID. */
  customer: string
  /** Exact origin already approved by the installation owner. */
  origin: string
}
export interface HostedPortalSessionIssue extends PortalSessionIssueBase {
  audience: 'hosted'
  parent?: never
}
export interface EmbeddedPortalSessionIssue extends PortalSessionIssueBase {
  audience: 'embedded'
  /** Exact embedding parent already approved by the installation owner. */
  parent: string
}
export type PortalSessionIssue = HostedPortalSessionIssue | EmbeddedPortalSessionIssue
export interface PortalSession {
  id: string
  /** Customer-scoped credential. Never log or publish it. */
  token: string
  /** Contains the customer-scoped credential. Never log or publish it. */
  url: string
  /** Epoch milliseconds. */
  expiresAt: number
}
export interface PortalSessionRevoke { session: string }
export interface PortalSessionRevoked { id: string; revoked: true }

export class PortalSessionsResource {
  constructor(private readonly transport: NectarTransport) {}

  /** Server-only owner invocation; retains native fresh-factor and host checks. */
  issue(input: PortalSessionIssue, options: WriteOptions): Promise<PortalSession> {
    return this.transport.request({ ...options, method: 'POST', path: 'portal.session.issue', body: input })
  }

  revoke(input: PortalSessionRevoke, options: WriteOptions): Promise<PortalSessionRevoked> {
    return this.transport.request({ ...options, method: 'POST', path: 'portal.session.revoke', body: input })
  }
}

export class PortalResource {
  readonly sessions: PortalSessionsResource
  constructor(transport: NectarTransport) {
    this.sessions = new PortalSessionsResource(transport)
  }
}
