// The landing, top to bottom, as the desk's page-s1 draws it: one billing
// month at Fieldnote Software from billing day to the close, the move-in last,
// then the closing and the footer. Pure server HTML; the page ships no script.
import './styles/landing.css'
import './styles/parts.css'
import { connectorDefs } from './parts'
import { assurance } from './sections/assurance'
import { billingDay } from './sections/billing-day'
import { closing } from './sections/closing'
import { monthEnd } from './sections/close'
import { collections } from './sections/collections'
import { hero } from './sections/hero'
import { invoice } from './sections/invoice'
import { moveIn } from './sections/move-in'
import { portal } from './sections/portal'
import { recovery } from './sections/recovery'
import { usageMoment } from './sections/usage'

// A line never starts with a separator: each " · ", " → " and " — " keeps to the word before it.
const keepSeparators = (html: string) => html.replace(/>([^<]+)</g, (_, text: string) => `>${text.replace(/ ([·→—]) /g, '\u00a0$1 ')}<`)

export const landing = (header: string, footer: string) => `${connectorDefs}${header}<main class="landing">`
  + keepSeparators([hero(), billingDay(), invoice(), recovery(), collections(), usageMoment(), portal(), assurance(), monthEnd(), moveIn(), closing()].join(''))
  + `</main>${footer}`
