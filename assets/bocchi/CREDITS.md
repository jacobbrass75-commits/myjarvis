# Bocchi avatar artwork

`spritesheet.webp` is the Codex/ChatGPT desktop pet **"Bocchi"** (Petdex slug `momo-4`, dex #4899,
sprite format v2: 192x208 cells, 8 columns x 11 rows), a chibi fan rendition of Hitori "Bocchi" Gotoh.

- Artist / submitter: **salma s.** on Petdex
- Source: <https://petdex.dev/pets/momo-4>
  (sheet: <https://assets.petdex.dev/pets/momo-c24b8a0b8c43/sprite.webp>, approved 2026-10-10)
- License: the creator declared a license that allows commercial use with credit (Petdex's
  "commercial" filter: CC0, CC BY or CC BY-SA; the public API doesn't say which of the three).
  Credit is given here and in `glasses/src/ui/bocchi.ts`.
- SHA-256: `ff7eaed558edc0fd877c7bd40a8b32d973c8f93df1859e4e2f158ae54adb276e` (fetched 2026-10-21)

Hitori Gotoh and *Bocchi the Rock!* are by Aki Hamaji (Houbunsha) and CloverWorks / Aniplex; this is
fan art, used here for a personal, non-public project.

The glasses use a converted copy: `scripts/build-bocchi-sprite.py` turns the rows below into 160x144,
16-level line-art frames (dark lines lit, light fills dim, because black is see-through on the lens) in
`glasses/src/ui/bocchi-frames.ts`. Re-run it after replacing the sheet.

| Assistant state | Sheet row |
| --- | --- |
| idle | 0 idle |
| listening | 6 waiting |
| thinking | 8 review |
| working (a tool runs) | 7 running (busy) |
| talking (a reply is up) | 4 jumping (open mouth, cheering) |
| failed (an error reply) | 5 failed |

Also considered (not used): `bocchi-guitar` by puff2002 (<https://petdex.dev/pets/bocchi-guitar>), the
most faithful full-body Bocchi with her guitar, but it has no declared license and its small full-body
figure leaves her face only about 30 px tall on the lens.
