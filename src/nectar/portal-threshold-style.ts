// Scoped to the contact's alert form; the rest of the portal keeps its own layout.
export const thresholdPortalStyle = `
.threshold-form{display:grid;gap:16px;margin-top:16px}
.threshold-form .field{display:grid;gap:6px;min-width:0}
.threshold-form .field label{font-weight:600}
.threshold-form input:not([type=checkbox]),.threshold-form select{width:100%;min-height:46px;padding:10px 12px;border:1px solid #b9c6bd;border-radius:8px;background:white;color:inherit;font:inherit}
.threshold-form input:not([type=checkbox]):focus,.threshold-form select:focus{outline:none;border:2px solid var(--accent);padding:9px 11px}
.threshold-form .check{display:flex;align-items:flex-start;gap:10px}
.threshold-form input[type=checkbox]{width:18px;height:18px;flex-shrink:0;accent-color:var(--accent);margin-top:3px}
.threshold-form button{justify-self:start;padding:10px 16px;border:1px solid var(--accent);border-radius:8px;background:var(--accent);color:white}
.threshold-form button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
`
