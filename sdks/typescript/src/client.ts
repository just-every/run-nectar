import { EntitlementsResource } from './entitlements.js'
import { MetadataResource } from './metadata.js'
import { PaymentLinksResource } from './payment-links.js'
import { PortalResource } from './portal.js'
import { NectarTransport, type NectarClientOptions, type NectarResponse, type RequestOptions } from './transport.js'
import { UsageResource } from './usage.js'

export class NectarClient {
  readonly usage: UsageResource
  readonly entitlements: EntitlementsResource
  readonly metadata: MetadataResource
  readonly paymentLinks: PaymentLinksResource
  readonly portal: PortalResource
  private readonly transport: NectarTransport

  constructor(options: NectarClientOptions) {
    this.transport = new NectarTransport(options)
    this.usage = new UsageResource(this.transport)
    this.entitlements = new EntitlementsResource(this.transport)
    this.metadata = new MetadataResource(this.transport)
    this.paymentLinks = new PaymentLinksResource(this.transport)
    this.portal = new PortalResource(this.transport)
  }

  request<T = unknown>(options: RequestOptions): Promise<T> {
    return this.transport.request<T>(options)
  }

  requestResult<T = unknown>(options: RequestOptions): Promise<NectarResponse<T>> {
    return this.transport.requestResult<T>(options)
  }
}
