#!/usr/bin/env node
// md2docx.mjs — convert markdown docs to refined .docx using docx-js (docx@9.6.x).
// Self-contained parser tuned to a pragmatic markdown subset (no external md parser).
// Managed by the Anchor `md2docx` skill — invoke via the `md2docx` wrapper, which
// resolves the bundled Node runtime + NODE_PATH=~/.anchor/env/node_modules.
//
// Usage (via wrapper):
//   md2docx <file1.md> [file2.md ...]
//   md2docx <file.md> -o <out.docx>
//   md2docx <file.md> --theme mineral|koica|mono   (default: mineral)
//   md2docx <file.md> --serif                       (Korean myeongjo body, formal)
//   md2docx <file.md> --header "Running header"      (override) | --no-header
//
// Supports: YAML frontmatter strip, H1–H6 (+italic subtitle), inline code/bold/italic/<br>,
//   links [text](url) + bare URLs, tables (align + label cells), nested bullets/numbered,
//   task lists (- [ ] / - [x]), blockquotes, fenced code blocks, horizontal rules, HTML comments.

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
// docx resolves from the Anchor env (NODE_PATH=~/.anchor/env/node_modules) via CJS
// require — ESM static `import` does NOT honor NODE_PATH for bare specifiers.
const require = createRequire(import.meta.url);
const {
  Document, Packer, Paragraph, TextRun, ExternalHyperlink, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
  Footer, Header, PageNumber, LevelFormat, VerticalAlign,
} = require("docx");

// ---------- themes (palettes) ----------
const THEMES = {
  // Executive Mineral — refined, muted, editorial (default)
  mineral: { h1: "181A1D", h2: "496A78", h3: "181A1D", h4: "496A78", ink: "181A1D",
    accent: "496A78", body: "42484C", muted: "737A7E", hairline: "DDD6C8", hairlineStrong: "C5BBA9",
    canvas: "F7F5EF", surface: "F0EEE6", code: "F2F0EA", link: "385662" },
  // KOICA brand — navy + KOICA blue
  koica: { h1: "0F2344", h2: "2563EB", h3: "0F2344", h4: "2563EB", ink: "0F2344",
    accent: "2563EB", body: "111827", muted: "6B7280", hairline: "E5E5E5", hairlineStrong: "C9D3E6",
    canvas: "F7F8FB", surface: "D9E2F3", code: "F7F7F9", link: "1D4ED8" },
  // Minimal monochrome
  mono: { h1: "111111", h2: "333333", h3: "111111", h4: "333333", ink: "111111",
    accent: "333333", body: "222222", muted: "666666", hairline: "CCCCCC", hairlineStrong: "999999",
    canvas: "F5F5F5", surface: "ECECEC", code: "F2F2F2", link: "333333" },
};

// ---------- mutable runtime state (set by CLI) ----------
let T = THEMES.mineral;
const FONT_SANS = { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "Malgun Gothic" };
const FONT_SERIF = { ascii: "Cambria", hAnsi: "Cambria", eastAsia: "바탕" };
const MONO = { ascii: "Consolas", hAnsi: "Consolas", eastAsia: "Malgun Gothic" };
let FONT = FONT_SANS;

// ---------- inline parsing → (TextRun|ExternalHyperlink)[] ----------
// pipeline: code spans (protected) → links → **bold** → _italic_/*italic*
function inlineRuns(text, base = {}) {
  const runs = [];
  let re = /`([^`]+)`/g, last = 0, m;
  const parts = [];
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ t: text.slice(last, m.index), code: false });
    parts.push({ t: m[1], code: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ t: text.slice(last), code: false });

  for (const p of parts) {
    if (p.code) {
      runs.push(new TextRun({ ...base, text: p.t, font: MONO, color: "C7254E",
        shading: { type: ShadingType.CLEAR, fill: T.code } }));
      continue;
    }
    for (const seg of splitLinks(p.t)) {
      if (seg.link) {
        runs.push(new ExternalHyperlink({
          link: seg.link.url,
          children: styleRuns(seg.link.text, { ...base, color: T.link, underline: {} }),
        }));
      } else {
        runs.push(...styleRuns(seg.t, base));
      }
    }
  }
  return runs.length ? runs : [new TextRun({ ...base, text: "", font: FONT })];
}

// split text into plain segments and links ([text](url) or bare http(s) URLs)
function splitLinks(s) {
  const out = [];
  let re = /\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+)/g, last = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ t: s.slice(last, m.index) });
    if (m[1] !== undefined) {
      out.push({ link: { text: m[1], url: m[2] } });
    } else {
      let url = m[3], trail = "";
      const tm = /[.,;:]+$/.exec(url);
      if (tm) { trail = tm[0]; url = url.slice(0, -trail.length); }
      out.push({ link: { text: url, url } });
      if (trail) out.push({ t: trail });
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: s.slice(last) });
  return out;
}

function styleRuns(s, base) {
  const out = [];
  let re = /\*\*([^*]+)\*\*/g, last = 0, m;
  const segs = [];
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) segs.push({ t: s.slice(last, m.index), bold: false });
    segs.push({ t: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) segs.push({ t: s.slice(last), bold: false });
  for (const seg of segs) out.push(...italicRuns(seg.t, { ...base, bold: base.bold || seg.bold }));
  return out;
}

function italicRuns(s, base) {
  const out = [];
  let re = /(?:_([^_]+)_)|(?:\*([^*]+)\*)/g, last = 0, m;
  const segs = [];
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) segs.push({ t: s.slice(last, m.index), it: false });
    segs.push({ t: m[1] ?? m[2], it: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) segs.push({ t: s.slice(last), it: false });
  for (const seg of segs) {
    if (seg.t === "") continue;
    out.push(new TextRun({ ...base, text: seg.t, italics: base.italics || seg.it, font: FONT }));
  }
  return out;
}

function runsWithBreaks(text, base = {}) {
  const lines = text.split(/<br\s*\/?>/i);
  const runs = [];
  lines.forEach((ln, i) => {
    if (i > 0) runs.push(new TextRun({ break: 1, font: FONT }));
    runs.push(...inlineRuns(ln.trim(), base));
  });
  return runs;
}

// ---------- block helpers ----------
const ALIGN = { l: AlignmentType.LEFT, c: AlignmentType.CENTER, r: AlignmentType.RIGHT };

function parseAlign(sep) {
  const s = sep.trim();
  const left = s.startsWith(":"), right = s.endsWith(":");
  if (left && right) return "c";
  if (right) return "r";
  return "l";
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

// refined table: subtle header fill, horizontal hairline row separators, no vertical rules
function buildTable(headerCells, aligns, rows) {
  const blankHeader = headerCells.every((c) => c === "");
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const hair = { style: BorderStyle.SINGLE, size: 4, color: T.hairline };
  const strong = { style: BorderStyle.SINGLE, size: 8, color: T.hairlineStrong };
  const margins = { top: 70, bottom: 70, left: 130, right: 130 };

  function cell(text, { header = false, label = false, align = "l", top = hair, bottom = hair } = {}) {
    return new TableCell({
      margins,
      verticalAlign: VerticalAlign.CENTER,
      borders: { top, bottom, left: none, right: none },
      shading: header
        ? { type: ShadingType.CLEAR, fill: T.surface }
        : label
        ? { type: ShadingType.CLEAR, fill: T.canvas }
        : undefined,
      children: [
        new Paragraph({
          alignment: ALIGN[align],
          spacing: { before: 20, after: 20 },
          children: runsWithBreaks(text, header ? { bold: true, color: T.ink } : {}),
        }),
      ],
    });
  }

  const trs = [];
  if (!blankHeader) {
    trs.push(new TableRow({
      tableHeader: true,
      children: headerCells.map((c, i) => cell(c, { header: true, align: aligns[i] || "l", top: strong, bottom: strong })),
    }));
  }
  rows.forEach((r, ri) => {
    const lastRow = ri === rows.length - 1;
    trs.push(new TableRow({
      children: r.map((c, i) => cell(c, {
        label: blankHeader && i === 0,
        align: aligns[i] || "l",
        bottom: lastRow ? strong : hair,
      })),
    }));
  });

  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: { insideHorizontal: hair }, rows: trs });
}

function hrParagraph() {
  return new Paragraph({
    spacing: { before: 140, after: 140 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: T.hairline, space: 1 } },
    children: [],
  });
}

function quoteParagraphs(lines) {
  return lines.map((ln, i) =>
    new Paragraph({
      spacing: { before: i === 0 ? 80 : 20, after: 20 },
      indent: { left: 360 },
      shading: { type: ShadingType.CLEAR, fill: T.canvas },
      border: { left: { style: BorderStyle.SINGLE, size: 18, color: T.hairlineStrong, space: 8 } },
      children: inlineRuns(ln, { italics: true, color: T.muted }),
    })
  );
}

function codeBlock(codeLines) {
  const runs = [];
  codeLines.forEach((ln, idx) => {
    if (idx > 0) runs.push(new TextRun({ break: 1, font: MONO }));
    runs.push(new TextRun({ text: ln.length ? ln : " ", font: MONO, size: 18, color: T.body }));
  });
  return new Paragraph({
    spacing: { before: 80, after: 80 },
    indent: { left: 140, right: 140 },
    shading: { type: ShadingType.CLEAR, fill: T.code },
    border: {
      top: { style: BorderStyle.SINGLE, size: 4, color: T.hairline, space: 6 },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: T.hairline, space: 6 },
      left: { style: BorderStyle.SINGLE, size: 18, color: T.hairlineStrong, space: 8 },
      right: { style: BorderStyle.SINGLE, size: 4, color: T.hairline, space: 6 },
    },
    children: runs.length ? runs : [new TextRun({ text: " ", font: MONO })],
  });
}

// ---------- mermaid flowchart → native docx flow diagram ----------
// Handles `flowchart TD/LR` / `graph` with node labels, |edge labels|, and
// dashed (-.text.->) edges. Renders a centered vertical stack of shaded boxes
// joined by ▼ arrows; non-linear edges (branches, loops, dashed) become muted
// annotations under their source box. Falls back to codeBlock on parse failure.
function parseMermaid(codeLines) {
  const nodes = {}, edges = [];
  const stripLabel = (br) => br ? br.slice(1, -1).replace(/^["']|["']$/g, "") : null;
  for (const raw of codeLines) {
    const l = raw.trim();
    if (!l || /^(flowchart|graph)\b/i.test(l) || /^%%/.test(l)) continue;
    const m = /^([A-Za-z0-9_]+)\s*(\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?\s*(-\.[^>]*?->|-->|---)\s*(?:\|([^|]*)\|)?\s*([A-Za-z0-9_]+)\s*(\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?/.exec(l);
    if (!m) continue;
    const [, a, al, conn, elab, b, bl] = m;
    if (al) nodes[a] = stripLabel(al);
    if (bl) nodes[b] = stripLabel(bl);
    const dashed = /^-\./.test(conn);
    const dm = /^-\.(.*)\.->$/.exec(conn);
    edges.push({ from: a, to: b, label: (dm && dm[1].trim()) || elab || null, dashed });
  }
  return { nodes, edges };
}

function mermaidFlow(codeLines) {
  const { nodes, edges } = parseMermaid(codeLines);
  if (!edges.length) return codeBlock(codeLines);

  const order = [];
  const see = (id) => { if (!order.includes(id)) order.push(id); };
  edges.forEach((e) => { see(e.from); see(e.to); });
  const idx = Object.fromEntries(order.map((id, k) => [id, k]));
  const label = (id) => (nodes[id] || id);

  const consec = {};   // k → arrow label between order[k] and order[k+1]
  const annot = {};    // nodeId → [annotation strings]
  edges.forEach((e) => {
    const ka = idx[e.from], kb = idx[e.to];
    if (kb === ka + 1) { consec[ka] = e.label || consec[ka] || ""; return; }
    const arrow = e.dashed ? "↻" : (kb < ka ? "↺" : "⤷");
    const lead = e.label ? `${e.label} → ` : "→ ";
    (annot[e.from] = annot[e.from] || []).push(`${arrow} ${lead}${label(e.to)}`.replace(/<br\s*\/?>/gi, " "));
  });

  const NB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const box = { style: BorderStyle.SINGLE, size: 8, color: T.hairlineStrong };
  const nodeCell = (id) => {
    const kids = [new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 20, after: annot[id] ? 0 : 20 },
      children: runsWithBreaks(label(id), { bold: true, color: T.ink }),
    })];
    (annot[id] || []).forEach((a) => kids.push(new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 0, after: 20 },
      children: inlineRuns(a, { italics: true, color: T.muted, size: 16 }),
    })));
    return new TableCell({
      margins: { top: 80, bottom: 80, left: 160, right: 160 },
      verticalAlign: VerticalAlign.CENTER,
      shading: { type: ShadingType.CLEAR, fill: T.surface },
      borders: { top: box, bottom: box, left: box, right: box },
      children: kids,
    });
  };
  const arrowCell = (lbl) => new TableCell({
    margins: { top: 10, bottom: 10, left: 60, right: 60 },
    borders: { top: NB, bottom: NB, left: NB, right: NB },
    children: [new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 },
      children: [
        new TextRun({ text: "▼", font: FONT, color: T.accent, size: 20 }),
        ...(lbl ? [new TextRun({ text: "  " + lbl, font: FONT, color: T.muted, size: 16, italics: true })] : []),
      ],
    })],
  });

  const rows = [];
  order.forEach((id, k) => {
    rows.push(new TableRow({ children: [nodeCell(id)] }));
    if (k < order.length - 1) rows.push(new TableRow({ children: [arrowCell(consec[k])] }));
  });

  return new Table({
    width: { size: 74, type: WidthType.PERCENTAGE },
    alignment: AlignmentType.CENTER,
    borders: { top: NB, bottom: NB, left: NB, right: NB, insideHorizontal: NB, insideVertical: NB },
    rows,
  });
}

function leadIndent(raw) {
  const m = /^[\t ]*/.exec(raw)[0].replace(/\t/g, "  ");
  return Math.min(3, Math.floor(m.length / 2));
}

// ---------- frontmatter ----------
function parseFrontmatter(md) {
  const meta = {};
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { meta, body: md };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: md.slice(m[0].length) };
}

// ---------- main parser ----------
function mdToBlocks(md) {
  md = md.replace(/<!--[\s\S]*?-->/g, ""); // strip HTML comments (internal refs)
  const lines = md.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  let numInstance = 0; // each ordered-list group gets its own instance so numbering restarts at 1

  const heading = (lvl) =>
    [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
     HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6][lvl - 1];

  while (i < lines.length) {
    let line = lines[i];
    if (line.trim() === "") { i++; continue; }

    // fenced code block
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, "").trim().toLowerCase();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++; // skip closing fence
      blocks.push(lang === "mermaid" ? mermaidFlow(code) : codeBlock(code));
      continue;
    }

    // headings
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      blocks.push(new Paragraph({
        heading: heading(lvl),
        alignment: lvl === 1 ? AlignmentType.CENTER : AlignmentType.LEFT,
        children: inlineRuns(h[2].trim()),
      }));
      if (lvl === 1) {
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === "") j++;
        const sub = lines[j]?.trim();
        if (sub && /^_.*_$/.test(sub)) {
          blocks.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 40, after: 160 },
            children: inlineRuns(sub.replace(/^_/, "").replace(/_$/, ""), { italics: true, color: T.muted }),
          }));
          i = j + 1;
          continue;
        }
      }
      i++;
      continue;
    }

    // horizontal rule
    if (/^(\*\*\*+|---+|___+)\s*$/.test(line.trim())) {
      blocks.push(hrParagraph());
      i++;
      continue;
    }

    // table
    if (line.includes("|") && i + 1 < lines.length &&
        /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(parseAlign);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
        rows.push(splitRow(lines[j]));
        j++;
      }
      blocks.push(buildTable(header, aligns, rows));
      blocks.push(new Paragraph({ spacing: { after: 80 }, children: [] }));
      i = j;
      continue;
    }

    // blockquote
    if (/^\s*>/.test(line)) {
      const qlines = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        qlines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(...quoteParagraphs(qlines.filter((l) => l.trim() !== "")));
      continue;
    }

    // bullet list (with nesting + task lists)
    if (/^\s*[-*]\s+/.test(line)) {
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const level = leadIndent(lines[i]);
        const txt = lines[i].replace(/^\s*[-*]\s+/, "");
        const task = /^\[([ xX])\]\s+(.*)$/.exec(txt);
        if (task) {
          const checked = task[1].toLowerCase() === "x";
          blocks.push(new Paragraph({
            spacing: { before: 20, after: 20 },
            indent: { left: 360 + level * 360, hanging: 240 },
            children: [
              new TextRun({ text: checked ? "☑  " : "☐  ", font: FONT, color: checked ? T.accent : T.muted }),
              ...inlineRuns(task[2]),
            ],
          }));
        } else {
          blocks.push(new Paragraph({
            bullet: { level },
            spacing: { before: 20, after: 20 },
            children: inlineRuns(txt),
          }));
        }
        i++;
      }
      continue;
    }

    // numbered list (with nesting)
    if (/^\s*\d+\.\s+/.test(line)) {
      numInstance++;
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const level = leadIndent(lines[i]);
        const txt = lines[i].replace(/^\s*\d+\.\s+/, "");
        blocks.push(new Paragraph({
          numbering: { reference: "num", level, instance: numInstance },
          spacing: { before: 20, after: 20 },
          children: inlineRuns(txt),
        }));
        i++;
      }
      continue;
    }

    // paragraph
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" &&
           !/^(#{1,6})\s/.test(lines[i]) && !/^\s*>/.test(lines[i]) &&
           !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) &&
           !lines[i].includes("|") && !/^\s*```/.test(lines[i]) &&
           !/^(\*\*\*+|---+)\s*$/.test(lines[i].trim())) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(new Paragraph({ spacing: { before: 40, after: 40 }, children: inlineRuns(para.join(" ")) }));
  }
  return blocks;
}

function firstH1(md) {
  const m = /^#\s+(.+)$/m.exec(md);
  return m ? m[1].replace(/[*_`]/g, "").trim() : null;
}

// ---------- document assembly ----------
function makeDoc(blocks, { title, headerText }) {
  const sectionChildren = {
    properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ children: [PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES], font: FONT, size: 16, color: T.muted })],
        })],
      }),
    },
    children: blocks,
  };
  if (headerText) {
    sectionChildren.headers = {
      default: new Header({
        children: [new Paragraph({
          alignment: AlignmentType.LEFT,
          spacing: { after: 40 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: T.hairline, space: 2 } },
          children: [new TextRun({ text: headerText, font: FONT, size: 15, color: T.muted, characterSpacing: 10 })],
        })],
      }),
    };
  }

  return new Document({
    title: title || undefined,
    creator: "md2docx (Anchor docx-js skill)",
    styles: {
      default: { document: { run: { font: FONT, size: 21, color: T.body }, paragraph: { spacing: { line: 276 } } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 38, bold: true, color: T.h1, font: FONT },
          paragraph: { spacing: { before: 120, after: 120 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: T.accent, space: 6 } } } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 28, bold: true, color: T.h2, font: FONT },
          paragraph: { spacing: { before: 280, after: 100 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: T.hairline, space: 3 } } } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 24, bold: true, color: T.h3, font: FONT },
          paragraph: { spacing: { before: 200, after: 60 } } },
        { id: "Heading4", name: "Heading 4", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 22, bold: true, color: T.h4, font: FONT },
          paragraph: { spacing: { before: 150, after: 40 } } },
        { id: "Heading5", name: "Heading 5", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 21, bold: true, color: T.muted, font: FONT },
          paragraph: { spacing: { before: 110, after: 40 } } },
      ],
    },
    numbering: {
      config: [{
        reference: "num",
        levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 480, hanging: 260 } } } },
          { level: 1, format: LevelFormat.LOWER_LETTER, text: "%2.", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 960, hanging: 260 } } } },
          { level: 2, format: LevelFormat.LOWER_ROMAN, text: "%3.", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 1440, hanging: 260 } } } },
          { level: 3, format: LevelFormat.DECIMAL, text: "%4)", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 1920, hanging: 260 } } } },
        ],
      }],
    },
    sections: [sectionChildren],
  });
}

// ---------- cli ----------
const argv = process.argv.slice(2);
let outOverride = null, themeName = "mineral", serif = false, headerOverride = undefined, noHeader = false;
const files = [];
for (let k = 0; k < argv.length; k++) {
  const a = argv[k];
  if (a === "-o") { outOverride = argv[++k]; continue; }
  if (a === "--theme") { themeName = (argv[++k] || "mineral").toLowerCase(); continue; }
  if (a === "--serif") { serif = true; continue; }
  if (a === "--no-header") { noHeader = true; continue; }
  if (a === "--header") { headerOverride = argv[++k]; continue; }
  files.push(a);
}
if (files.length === 0) {
  console.error("usage: md2docx <file.md> [more.md ...] [-o out.docx] [--theme mineral|koica|mono] [--serif] [--header TEXT|--no-header]");
  process.exit(1);
}
T = THEMES[themeName] || THEMES.mineral;
FONT = serif ? FONT_SERIF : FONT_SANS;

for (const f of files) {
  const raw = readFileSync(f, "utf8");
  const { meta, body } = parseFrontmatter(raw);
  const title = meta.title || firstH1(body) || basename(f).replace(/\.md$/i, "");
  // if frontmatter had a title but body has no H1, promote title to a centered H1
  const md = (meta.title && !firstH1(body)) ? `# ${meta.title}\n\n${body}` : body;
  const headerText = noHeader ? undefined : (headerOverride !== undefined ? headerOverride : title);
  const blocks = mdToBlocks(md);
  const doc = makeDoc(blocks, { title, headerText });
  const buf = await Packer.toBuffer(doc);
  const out = outOverride && files.length === 1
    ? outOverride
    : join(dirname(f), basename(f).replace(/\.md$/i, "") + ".docx");
  writeFileSync(out, buf);
  console.log(`✓ ${out}  (${(buf.length / 1024).toFixed(1)} KB, ${blocks.length} blocks, theme=${themeName}${serif ? ", serif" : ""})`);
}
