import { h, type Html } from './html'
/** The description remains accessible while the visual hint waits for hover. */
export function tooltipLink(href:string,label:string,id:string,content:Html,hint='Open invoice') {
 return h`<span class="nc-tooltip-wrap"><a class="icon-link" href="${href}" aria-label="${label}" aria-describedby="${id}">${content}</a><span class="nc-tooltip" id="${id}" role="tooltip">${hint}</span></span>`
}
