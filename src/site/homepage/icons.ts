// The line icons inside the homepage's round tiles: 24-unit strokes in
// currentColor, drawn here so the page makes no request for them.
const PATHS = {
  invoice: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/>',
  building: '<path d="M5 21V5l7-2v18M12 8l7 2v11M3 21h18M8 8h1M8 12h1M8 16h1M15 13h1M15 17h1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  chart: '<path d="M6 20v-6M12 20V8M18 20V4"/>',
  card: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/>',
  bank: '<path d="M3 10 12 4l9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10.5" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  calculator: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M8.5 7.5h7M9 12h.01M12 12h.01M15 12h.01M9 16h.01M12 16h.01M15 16h.01"/>',
  code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>',
  file: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h3"/>',
  coins: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  ledger: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  percent: '<path d="M19 5 5 19"/><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="17" r="2.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 6v8M12 18h.01"/>',
  arrow: '<path d="M4 12h15M13 6l6 6-6 6"/>',
}
export type IconName = keyof typeof PATHS

export const icon = (name: IconName, className = 'i') => `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name]}</svg>`

/** The cursor arrow every collaborator tag hangs from. */
export const ARROW_CURSOR = '<svg viewBox="0 0 24 28" aria-hidden="true"><path d="M3 2.5 20.5 15l-8 1.4L8.2 25z"/></svg>'

/** Three short orange strokes, the page's spark doodle. */
export const SPARK = '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M21 3.5 25 14M7.5 9.5l9 7.5M3.5 25h11"/></svg>'
