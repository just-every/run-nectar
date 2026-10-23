# Fonts

Hanken Grotesk is self-hosted under the SIL Open Font License 1.1 in
`hanken-grotesk/LICENSE.txt`. The Latin and Latin Extended variable WOFF2
subsets (weights 100 to 900; Nectar uses 400, 500, 700 and 800) come from
Fontsource's `@fontsource-variable/hanken-grotesk` 5.3.0; upstream:
https://github.com/marcologous/hanken-grotesk.

The app, Base's sign-in and setup documents and the run site link
`/fonts/fonts.css` once and preload only the primary Latin file. Do not import
this CSS from a component. The faces are declared in `/rer-theme.css`, the one
file rer's theme reader takes, so the installer serves them too; `fonts.css`
holds the page font and the rest of Nectar's look. Every body-font stack uses
`--font-body`, including the local `Hanken Grotesk Fallback` before generic
fallback fonts; controls inherit it.

Fallback scales use Hanken Grotesk/Arial advance-width ratios over A-Z, a-z and
0-9 at weights 400, 500, 700 and 800 (Arial Bold for 700 and 800). Ascent,
descent and line gap match Hanken Grotesk's 1000, -303 and 0 per 1000 units,
divided by each scale. Recalculate the fallback and preload when changing the
brand font.
