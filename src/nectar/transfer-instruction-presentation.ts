import type { CustomerText } from './locale'
import type { TransferInstructions } from './transfer-instructions'

export function transferInstructionFacts(fields: TransferInstructions, L: CustomerText): [string,string][] {
  return [
    [L.t('transfer.bankName'),fields.bankName], [L.t('transfer.accountHolderName'),fields.accountHolderName],
    [L.t('transfer.accountNumber'),fields.accountNumber], [L.t('transfer.routingNumber'),fields.routingNumber],
    [L.t('transfer.accountType'),L.t(`transfer.${fields.accountType}`)],
    [L.t('transfer.networks'),fields.networks.map(network=>L.t(`transfer.${network}`)).join(', ')],
    [L.t('transfer.currency'),fields.currency], [L.t('transfer.country'),L.t(`transfer.${fields.country}`)],
  ]
}
