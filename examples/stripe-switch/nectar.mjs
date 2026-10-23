// Server-side sample: inject your authenticated backend API transport. Never
// put an operator session or a merchant provider key in browser code.
export class NectarBillingApp {
  constructor(api) { this.api=api }
  invoicePreview({subscription,account_ref}) {
    // The app does not branch on customer migration state.
    return this.api('app.invoice.preview',{subscription,account_ref})
  }
  prepareQuantity({subscription,account_ref,item,quantity}) {
    return this.api('shadow.app.prepare',{subscription,account_ref,item,quantity})
  }
  confirmChange(change,confirmed) {
    if(confirmed!==true)throw new Error('Explicit owner confirmation required')
    return this.api('shadow.app.confirm',{change,confirm:true})
  }
  reconcileChange(change) { return this.api('shadow.app.reconcile',{change}) }
}
