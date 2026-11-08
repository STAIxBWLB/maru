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
positions with shaping disabled. Unsupported nonignorables use the actual
font glyph 0 (`.notdef`) with its table advance, side bearing and ink bounds.
Both pinned fonts lack a mapping for the Unicode replacement character �;
the runtime does not pretend that character is mapped. Coverage never blocks
the run: `replacements` counts unsupported nonignorables and `diagnostics`
contains one nonfatal `document/font-replacement-notice` when the count is
nonzero. Invalid size/weight, coordinate overflow and malformed bundled data
remain explicit errors.

For known characters, `rendered` names the scalar mapped to `glyphId`. A
replacement has `glyphId: 0`, `rendered: ""`, `replaced: true` and
`ignored: false`. E3 must draw the original pinned font's glyph 0 outline/box
at the returned origin. Rendering the original unsupported Unicode scalar
would invoke platform fallback and is prohibited; drawing an invented box
from the advance alone would also disagree with the measured ink.

Unicode 17.0.0 `Default_Ignorable_Code_Point` data (4,174 scalars) is pinned
from [DerivedCoreProperties.txt](https://www.unicode.org/Public/17.0.0/ucd/DerivedCoreProperties.txt).
These inputs, including variation selectors and ZWJ/ZWNJ, have zero advance
and no ink even when a cmap entry exists. Their output uses `ignored: true`,
`replaced: false`, `glyphId: 0` and `rendered: ""`; E3 skips them instead of
drawing the `.notdef` glyph. The original scalar remains in `input` for
attribution. Ignorables do not increase `replacements` or produce a notice.
The associated [Unicode License V3](UNICODE-LICENSE.txt) is preserved beside
this module; its official source is https://www.unicode.org/license.txt.
The font manifest records this property version and rendering policy.

Coordinates use 1/64 pixel units. Glyph origins and total advance are scaled
from cumulative font-unit advances, rounded nearest with ties away from zero.
Individual advances are differences of those rounded origins, so they sum to
the total without drift. Ink bounds round outward and use screen coordinates
relative to the baseline (positive y is down). Empty or inkless text has a zero
ink box. No layout algorithm is introduced here.
