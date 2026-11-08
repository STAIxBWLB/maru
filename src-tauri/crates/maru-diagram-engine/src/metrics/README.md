# Pinned text metrics

The metric data is derived from Noto Sans CJK KR Regular 400 and Bold 700 at
revision `f8d157532fbfaeda587e826d4cd5b21a49186f7c`. The source OTFs stay in the
ignored remote cache. `data/manifest.json` records their immutable URLs,
SHA-256 hashes, units, coverage and integer probes; `data/LICENSE.OFL` and
`data/NOTICE.md` preserve the source license and copyright records. The data
uses OFL-1.1 separately from the SDK code license.

Run `node scripts/diagram-engine-e2-fonts.mjs` through the remote-dev runner to
regenerate, or add `--check` for byte-for-byte drift verification. The tool is
Linux-only so source font binaries are never downloaded to a desktop by this
workflow. It uses the optional `font-tools` parser; normal validation and the
runtime geometry module do not depend on a font parser or font installation.

`MDFONT01` stores sorted cmap-to-original-glyph-ID mappings and deduplicated
horizontal advance, side bearing and ink-bounds records in integer font units.
The runtime returns a single unshaped horizontal run. It does not apply
normalization, kerning, ligatures, localized substitutions, wrapping or OS
fallback. E3 must use the same pinned fonts, original glyph IDs and returned
positions with shaping disabled. An unknown scalar maps to the literal
replacement character � if the pinned font covers it; otherwise it produces an
explicit diagnostic. This policy also applies to unmapped controls.

Coordinates use 1/64 pixel units. Glyph origins and total advance are scaled
from cumulative font-unit advances, rounded nearest with ties away from zero.
Individual advances are differences of those rounded origins, so they sum to
the total without drift. Ink bounds round outward and use screen coordinates
relative to the baseline (positive y is down). Empty or inkless text has a zero
ink box. No layout algorithm is introduced here.
