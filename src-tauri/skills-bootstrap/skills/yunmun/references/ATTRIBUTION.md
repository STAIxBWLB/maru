# Attribution

Parts of this skill are adapted from **sepia** v0.11.0 by Nanako Tsai, <https://github.com/Nanako0129/sepia>, released under the MIT License.

## What was ported, and how it was changed

| File here | Upstream source | Change |
|---|---|---|
| `professional-pass.md` | `skills/sepia/references/professional-pass.md` | Renamed report header, added Korean venue rows, the form-ownership whitelist row, and pointers to `languages/ko.md` |
| `style-pass.md` | `skills/sepia/references/style-pass.md` | Fiction-only vocabulary rows removed; English-only scope note added |
| `discourse-pass.md` | `skills/sepia/references/discourse-pass.md` | Sections 1–3 only, rewritten for professional prose: conventional structure is not a defect, fiction rows removed, fixes never add material |
| `model-fingerprints.md` | `skills/sepia/references/model-fingerprints.md` | Prose layers only; narrative (fiction) layers removed; header rewritten |
| `domains/release-notes.md`, `dev-replies.md`, `postmortems.md`, `tickets.md`, `tech-articles.md` | same paths upstream | Name references only |
| `domains/journalism.md` | `skills/sepia/references/domains/journalism.md` | Rewritten: language-neutral rules kept, Taiwan-corpus rows replaced by Korean examples marked as editorial inference |
| `SKILL.md` | `skills/sepia/SKILL.md` | Restructured as a single skill with mode sections; security boundary, operations, calibration and guardrails adapted; fiction routes, voices and wrappers dropped |

New in this skill and not from upstream: `languages/ko.md`, `domains/reports-plans.md`, `domains/proposals.md`, `domains/correspondence.md`, `domains/academic.md`.

## Korean references behind `languages/ko.md`

All MIT. Ideas and published measurements are used with credit; rules are restated and every example is new. No text is copied.

| Source | Use |
|---|---|
| **im-not-ai**, Copyright (c) 2026 epoko77-ai, <https://github.com/epoko77-ai/im-not-ai> | Its published corpus study (confirmed *and rejected* patterns) is evidence class I in §1.2 and §2A; its modality-preservation, reverse-injection and change-budget ideas inform §7. Its detector-bypass framing is not adopted |
| **fluent-korean**, Copyright (c) 2026 snflkd, <https://github.com/snflkd/fluent-korean> | The compressed pole, §2B, and two rows of §3 |
| **korean-skills**, Copyright (c) 2026 Dale Seo, <https://github.com/DaleSeo/korean-skills> | Practitioner rows marked D in §2A and several §0 conventions. Not adopted: deliberate spacing errors, mixing 해요체 into formal text, and treating Sino-Korean vocabulary as an AI marker, which conflict with this skill's guardrails and with I's measurements |
| **k-skill** korean-humanizer, <https://github.com/NomaDamas/k-skill> | Checked; by its own statement a restructuring of im-not-ai, so not used separately |
| KatFishNet, Park et al., ACL 2025, arXiv:2503.00032 | Evidence class K, read from the paper |

Ledger identifiers quoted in the ported files (for example `SHAN-EDIT-2026`, `SAAD-TING-2026`, `SOURATI-2026`) refer to the upstream research ledger at <https://github.com/Nanako0129/sepia/tree/v0.11.0/research>, which is not bundled here.

## Upstream license notice

```text
MIT License

Copyright (c) 2026 Nanako Tsai

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
