const names: Record<string,string> = { bank_transfer:'Bank transfer',check:'Check',card_external:'Card',other:'Other' }
export const paymentMethodName = (method:string) => names[method]
