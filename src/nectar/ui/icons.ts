// Outline icons for the app shell and status chips: 24-unit paths stroked in
// currentColor, drawn inline so the page needs no image request or script.
import type { Html } from './html'

const PATHS = {
  home: 'M3.5 10.5 12 4l8.5 6.5M5.5 9v10.5h13V9M10 19.5v-5h4v5',
  receivables: 'M6.5 3.5h11v17h-11zM12 7.5v9M14.5 9.2c-.4-.8-1.3-1.2-2.5-1.2-1.4 0-2.4.7-2.4 1.8 0 2.6 5 1.4 5 4 0 1.1-1.1 1.9-2.6 1.9-1.3 0-2.3-.5-2.7-1.4',
  customers: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 20.5c.8-3.6 3.8-5.6 7.5-5.6s6.7 2 7.5 5.6',
  usage: 'M5 20.5v-6M10 20.5V9.5M15 20.5V4M20 20.5v-9',
  billing: 'M7 3.5h7.5L19 8v12.5H7zM14 3.5V8.5h5M10 12.5h6M10 16h6',
  catalog: 'M3.5 12.6 11.4 4.7a1 1 0 0 1 .7-.3h7a.9.9 0 0 1 .9.9v7a1 1 0 0 1-.3.7l-7.9 7.9a1 1 0 0 1-1.4 0l-6.9-6.9a1 1 0 0 1 0-1.4ZM16 8.5h.01',
  proposals: 'M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20M5.5 5h13L20 13.5v6H4v-6Z',
  movein: 'M12 3.5v10M8 10l4 4 4-4M4.5 15.5v4h15v-4',
  exports: 'M12 14.5v-11M8 7.5l4-4 4 4M4.5 15.5v4h15v-4',
  audit: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5V12l3 2',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 13.5l1.6 1.2-2 3.5-1.9-.7a7.5 7.5 0 0 1-2.2 1.3l-.3 2h-4l-.3-2a7.5 7.5 0 0 1-2.2-1.3l-1.9.7-2-3.5 1.6-1.2a7.6 7.6 0 0 1 0-2.6L3.2 9.3l2-3.5 1.9.7a7.5 7.5 0 0 1 2.2-1.3l.3-2h4l.3 2a7.5 7.5 0 0 1 2.2 1.3l1.9-.7 2 3.5-1.6 1.2a7.6 7.6 0 0 1 0 2.6Z',
  access: 'M14.5 10a4.5 4.5 0 1 0-4 4.47V20.5h3v-2h2v-2h-2v-2.03A4.5 4.5 0 0 0 14.5 10ZM10 9.5h.01',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  sparkle: 'M12 3.5c.6 4.4 2.3 6.4 7.5 7.5-5.2 1.1-6.9 3.1-7.5 7.5-.6-4.4-2.3-6.4-7.5-7.5 5.2-1.1 6.9-3.1 7.5-7.5ZM18.5 16.5c.2 1.6.8 2.2 2 2.5-1.2.3-1.8.9-2 2.5-.2-1.6-.8-2.2-2-2.5 1.2-.3 1.8-.9 2-2.5Z',
  paid: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8 12.2l2.7 2.7L16 9.5',
  alert: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5v5.5M12 16.5h.01',
  warn: 'M10.3 4.3 2.8 17.5a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0ZM12 9.5v4M12 17h.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7.5V12l3 2',
  open: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  card: 'M3.5 6.5h17v11h-17zM3.5 10h17M7 14.5h3',
  bank: 'M3.5 9.5 12 4.5l8.5 5M5.5 10v7M9.8 10v7M14.2 10v7M18.5 10v7M3.5 20h17',
  check: 'M6.5 4.5h11v15h-11zM9 9h6M9 12.5h6M9 16h3',
  synced: 'M19.5 12a7.5 7.5 0 0 1-13.2 4.9M4.5 12a7.5 7.5 0 0 1 13.2-4.9M18 3.5v3.8h-3.8M6 20.5v-3.8h3.8',
  arrow: 'M5 12h14M13 6l6 6-6 6',
} as const

export type IconName = keyof typeof PATHS

export const icon = (name: IconName, className = 'icon'): Html =>
  ({ html: `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${PATHS[name]}"/></svg>` })
