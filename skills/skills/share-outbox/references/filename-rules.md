# Filename Rules

Outgoing filenames are for external recipients, so the visible name should be a
human Korean title plus public author suffix plus timestamp.

Default shape:

```text
{한글제목}_{AUTHOR}_{YYMMDD-HHMM}.{ext}
```

## Title Resolution

Use this order:

1. User-provided Korean title.
2. Inbox manifest `source.original_name`.
3. Primary raw filename from the inbox item.
4. Template filename.
5. A concise Korean title chosen after inspecting the content.

If the selected title has no Hangul, do not keep an internal English filename.
Inspect the document and provide `--title`.

## Suffix Replacement

Strip only trailing operational suffixes from the title stem, then append the
configured author and timestamp.

Examples of suffixes that may be stripped when configured:

- internal author codes
- version markers such as `v2`
- date fragments such as `0505`
- draft/final markers
- Korean final/edit markers

Do not strip meaningful title text in the middle of a filename.

## Sanitization

- Preserve Hangul, spaces, parentheses, and common punctuation.
- Remove path separators and control characters.
- Collapse repeated whitespace.
- Preserve the source file extension exactly as the outgoing extension.
