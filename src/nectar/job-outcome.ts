// A handled business outcome still needs operational attention. This fixed
// allowlist contains no provider text and never changes work eligibility.
export function jobNeedsAttention(status: string | undefined) {
  return status !== undefined && ['failed', 'rejected', 'rate_limited', 'uncertain',
    'unconfirmed', 'not_configured', 'refused', 'returned', 'invalidated',
    'requires_action', 'requires_payment_method', 'blocked'].includes(status)
}
