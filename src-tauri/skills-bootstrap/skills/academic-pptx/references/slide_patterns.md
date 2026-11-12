# Slide Patterns for Academic Presentations

Implementation patterns for each required slide type. Use with the host's pptx skill (pptxgenjs) for the technical API.

Example coordinates assume `LAYOUT_16x9` (10" × 5.625"). This skill builds on `LAYOUT_WIDE` (13.33" × 7.5"): multiply every x, y, w and h by 1.333.

---

## Global Defaults

Apply these to every slide in an academic deck:

```javascript
const COLORS = {
  bg:       "FFFFFF",   // White background
  primary:  "1F4E79",   // Dark navy — titles
  accent:   "2E75B6",   // Mid-blue — headers, highlights
  body:     "2D2D2D",   // Near-black — body text
  muted:    "777777",   // Gray — citations, captions
  highlight:"FFF2CC",   // Yellow — callout boxes (use sparingly)
};

const FONTS = {
  face: "Noto Sans KR",  // Single Hangul-capable typeface throughout (see SKILL.md)
  title: 26,             // Action title: 26–28 pt
  sectionHeader: 22,     // Within-slide section headers
  body: 20,              // Body bullets: 20 pt minimum
  label: 16,             // Chart annotations, inline labels
  cite: 13,              // In-slide citations, footnotes
};

const MARGIN = 0.5;      // Minimum margin from slide edge (inches)
```

---

## 1. Title Slide

**Purpose:** Establish the presentation; give the audience complete attribution.

```javascript
// Dark background treatment — one of the few places for it
slide.background = { color: COLORS.primary };

// Main title — framed as a statement or question
slide.addText("Treatment effect of early childhood interventions\npersists into adulthood across all income quartiles", {
  x: 0.7, y: 1.4, w: 8.6, h: 1.8,
  fontSize: 32, fontFace: FONTS.face, color: "FFFFFF",
  bold: true, align: "left", valign: "top"
});

// Subtitle / conference context
slide.addText("Annual Conference of the Society for Labor Economics  ·  May 2025", {
  x: 0.7, y: 3.2, w: 8.6, h: 0.4,
  fontSize: 16, fontFace: FONTS.face, color: "FFFFFF",
  align: "left"
});

// Author and affiliation
slide.addText("Jane Smith¹  ·  John Doe²\n¹ University of X   ² Laboratory for Y", {
  x: 0.7, y: 3.7, w: 8.6, h: 0.6,
  fontSize: 15, fontFace: FONTS.face, color: "FFFFFF",
  align: "left"
});

```

**Do not include:** Decorative images, animated logos, institution crests (unless explicitly requested), clip art.

---

## 2. Motivation / Context Slide

**Purpose:** Establish the situation and complication — why this question matters and what's missing.

Layout: Two-column (context left, gap/problem right) or single-column narrative. Use single-column for most conference talks.

```javascript
// Action title
slide.addText("Existing interventions show strong short-run effects but evidence on persistence is sparse", {
  x: MARGIN, y: 0.2, w: 9.0, h: 0.8,
  fontSize: FONTS.title, fontFace: FONTS.face, color: COLORS.primary, bold: true, valign: "top"
});


// Body bullets
slide.addText([
  { text: "Short-run gains well established: ", options: { bullet: true, bold: true, breakLine: false } },
  { text: "meta-analyses confirm positive effects at ages 5–8 (Heckman et al. 2013).", options: { breakLine: true } },
  { text: "Long-run evidence is scarce: ", options: { bullet: true, bold: true, breakLine: false } },
  { text: "only 3 RCTs track outcomes past age 25; none cover lower-income countries.", options: { breakLine: true } },
  { text: "Mechanism is unresolved: ", options: { bullet: true, bold: true, breakLine: false } },
  { text: "cognitive vs. non-cognitive channels remain debated (see Appendix A).", options: { breakLine: true } },
], {
  x: MARGIN, y: 1.1, w: 9.0, h: 3.2,
  fontSize: FONTS.body, fontFace: FONTS.face, color: COLORS.body,
  paraSpaceAfter: 12
});

// In-slide citation
slide.addText("Heckman et al. (2013), Science; Cunha & Heckman (2007), AER", {
  x: MARGIN, y: 5.1, w: 9.0, h: 0.35,
  fontSize: FONTS.cite, fontFace: FONTS.face, color: COLORS.muted, align: "left"
});
```

---

## 3. Research Question Slide

**Purpose:** Give the audience the anchor they need to evaluate everything that follows. This slide must exist on its own.

```javascript
// Action title
slide.addText("This paper asks: do early childhood effects persist to age 35,\nand through which channels?", {
  x: MARGIN, y: 0.2, w: 9.0, h: 0.9,
  fontSize: FONTS.title, fontFace: FONTS.face, color: COLORS.primary, bold: true
});


// Research question in a prominent callout box
slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
  x: 1.5, y: 1.4, w: 7.0, h: 1.6,
  fill: { color: COLORS.bg }, line: { color: COLORS.accent, width: 1.5 }, rectRadius: 0.1
});

slide.addText("Do effects of the X program on cognitive and socio-emotional skills\nat age 8 persist to age 35 outcomes (earnings, health, crime),\nand does the pathway run through skills or through schooling attainment?", {
  x: 1.7, y: 1.55, w: 6.6, h: 1.3,
  fontSize: FONTS.body, fontFace: FONTS.face, color: COLORS.primary,
  bold: false, align: "left", valign: "middle"
});

// Optional: brief note on what makes this paper's approach novel
slide.addText([
  { text: "Contribution: ", options: { bold: true, breakLine: false } },
  { text: "First study to follow a randomized cohort from ages 3–5 to 35; administrative earnings and health records linked to original experimental data.", options: {} }
], {
  x: MARGIN, y: 3.2, w: 9.0, h: 1.0,
  fontSize: FONTS.body, fontFace: FONTS.face, color: COLORS.body
});
```

---

## 4. Methods Slide

**Purpose:** Give the audience what they need to evaluate the findings — not procedural completeness.

Target: 1–2 slides. Move all detail the audience doesn't need to Appendix.

```javascript
// Action title
slide.addText("Regression discontinuity exploits a sharp household income threshold\nfor program eligibility — treatment is as-good-as-random near the cutoff", {
  x: MARGIN, y: 0.2, w: 9.0, h: 0.9,
  fontSize: FONTS.title, fontFace: FONTS.face, color: COLORS.primary, bold: true
});


// Two-column: design on left, key variables on right
// Left column header
slide.addText("Design", {
  x: MARGIN, y: 1.25, w: 4.2, h: 0.35,
  fontSize: FONTS.sectionHeader, fontFace: FONTS.face, color: COLORS.accent, bold: true
});

slide.addText([
  { text: "Cohort: ", options: { bullet: true, bold: true, breakLine: false } },
  { text: "2,400 children born 1985–90 in three counties", options: { breakLine: true } },
  { text: "Assignment: ", options: { bullet: true, bold: true, breakLine: false } },
  { text: "income < 185% FPL at age 3 → eligible (N = 1,150)", options: { breakLine: true } },
  { text: "Follow-up: ", options: { bullet: true, bold: true, breakLine: false } },
  { text: "ages 5, 8, 18, 25, 35 — admin records linked", options: { breakLine: true } },
], {
  x: MARGIN, y: 1.65, w: 4.2, h: 2.4,
  fontSize: FONTS.body, fontFace: FONTS.face, color: COLORS.body,
  paraSpaceAfter: 10
});

// Right column header
slide.addText("Key outcomes", {
  x: 5.3, y: 1.25, w: 4.2, h: 0.35,
  fontSize: FONTS.sectionHeader, fontFace: FONTS.face, color: COLORS.accent, bold: true
});

slide.addText([
  { text: "Primary: ", options: { bullet: true, bold: true, breakLine: false } },
  { text: "age-35 earnings (log), employment", options: { breakLine: true } },
  { text: "Secondary: ", options: { bullet: true, bold: true, breakLine: false } },
  { text: "health index, criminal record indicator", options: { breakLine: true } },
  { text: "Mechanism: ", options: { bullet: true, bold: true, breakLine: false } },
  { text: "cognitive score age 8, years of schooling", options: { breakLine: true } },
], {
  x: 5.3, y: 1.65, w: 4.2, h: 2.4,
  fontSize: FONTS.body, fontFace: FONTS.face, color: COLORS.body,
  paraSpaceAfter: 10
});

// Appendix pointer
slide.addText("Full identification assumptions and robustness checks → Appendix B", {
  x: MARGIN, y: 5.1, w: 9.0, h: 0.35,
  fontSize: FONTS.cite, fontFace: FONTS.face, color: COLORS.muted, align: "left"
});
```

---

## 5. Results Slide

**Purpose:** Present one finding, make it impossible to miss.

Layout: Figure left (~5.5"), interpretive text right (~3.5"). Action title states the result.

```javascript
// Action title — MUST state the finding, not just the topic
slide.addText("Treated children earn 18% more at age 35 — effect is largest in the bottom income quartile", {
  x: MARGIN, y: 0.2, w: 9.0, h: 0.85,
  fontSize: FONTS.title, fontFace: FONTS.face, color: COLORS.primary, bold: true
});


// FIGURE (left side) — rebuilt from paper, not copy-pasted
// Replace with actual chart or image
slide.addChart(pres.charts.BAR, [{
  name: "Treatment effect (%)",
  labels: ["Q1 (lowest)", "Q2", "Q3", "Q4 (highest)"],
  values: [28, 22, 15, 8]
}], {
  x: MARGIN, y: 1.15, w: 5.4, h: 3.8,
  barDir: "col",
  chartColors: [COLORS.accent],
  chartArea: { fill: { color: COLORS.bg } },
  catAxisLabelColor: COLORS.muted,
  valAxisLabelColor: COLORS.muted,
  catAxisLabelFontSize: FONTS.label,
  valAxisLabelFontSize: FONTS.label,
  valGridLine: { style: "none" },
  catGridLine: { style: "none" },
  showValue: true,
  dataLabelColor: COLORS.body,
  dataLabelFontSize: FONTS.label,
  showLegend: false,
  valAxisTitle: "Log earnings effect (%)",
  showValAxisTitle: true,
  valAxisTitleColor: COLORS.muted,
  valAxisTitleFontSize: FONTS.label,
});

// KEY FINDING ANNOTATION — tell the audience exactly what to see
// (In practice, add a call-out arrow/box over the chart image or use addText overlay)
slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
  x: 0.55, y: 1.2, w: 1.8, h: 0.5,
  fill: { color: COLORS.highlight }, line: { color: COLORS.highlight, width: 1 }, rectRadius: 0.06
});
slide.addText("↑ 28% for Q1", {
  x: 0.55, y: 1.2, w: 1.8, h: 0.5,
  fontSize: FONTS.label, fontFace: FONTS.face, color: COLORS.primary, bold: true, align: "center", valign: "middle"
});

// INTERPRETIVE TEXT (right side)
slide.addText("What to take away", {
  x: 6.2, y: 1.15, w: 3.3, h: 0.35,
  fontSize: FONTS.sectionHeader, fontFace: FONTS.face, color: COLORS.accent, bold: true
});

slide.addText([
  { text: "Average effect: 18% earnings gain (p < 0.001)", options: { bullet: true, breakLine: true } },
  { text: "Heterogeneity: effects are 3.5× larger for Q1 vs Q4", options: { bullet: true, breakLine: true } },
  { text: "Precision: 95% CI = [14%, 22%] for pooled estimate", options: { bullet: true, breakLine: true } },
], {
  x: 6.2, y: 1.55, w: 3.3, h: 2.5,
  fontSize: FONTS.body, fontFace: FONTS.face, color: COLORS.body,
  paraSpaceAfter: 12
});

// In-slide citation
slide.addText("Administrative earnings records, Social Security Administration (accessed 2024)", {
  x: MARGIN, y: 5.15, w: 9.0, h: 0.3,
  fontSize: FONTS.cite, fontFace: FONTS.face, color: COLORS.muted
});
```

**Critical checks for results slides:**
- Action title states the finding, not the topic
- Key result is annotated directly on the chart (arrow, box, highlight, or call-out label)
- Source cited at the bottom
- No second chart or second finding on the same slide

---

## 6. Discussion / Implications Slide

**Purpose:** Interpret the findings; connect back to the opening question; address the main limitation.

```javascript
// Action title
slide.addText("Results support a skill-formation pathway: the earnings effect is fully mediated\nby cognitive scores at age 8, not by schooling attainment", {
  x: MARGIN, y: 0.2, w: 9.0, h: 0.9,
  fontSize: FONTS.title, fontFace: FONTS.face, color: COLORS.primary, bold: true
});


// Interpretation
slide.addText("Interpretation", {
  x: MARGIN, y: 1.2, w: 9.0, h: 0.35,
  fontSize: FONTS.sectionHeader, fontFace: FONTS.face, color: COLORS.accent, bold: true
});

slide.addText([
  { text: "Consistent with Cunha-Heckman (2007) skill complementarity: early investment compounds through the schooling years.", options: { bullet: true, breakLine: true } },
  { text: "Schooling channel: coefficient falls to zero when conditioning on age-8 cognitive score (mediation analysis, Appendix C).", options: { bullet: true, breakLine: true } },
], {
  x: MARGIN, y: 1.6, w: 9.0, h: 1.3,
  fontSize: FONTS.body, fontFace: FONTS.face, color: COLORS.body,
  paraSpaceAfter: 10
});

// Main limitation — address it directly
slide.addText("Main limitation", {
  x: MARGIN, y: 3.0, w: 9.0, h: 0.35,
  fontSize: FONTS.sectionHeader, fontFace: FONTS.face, color: COLORS.accent, bold: true
});

slide.addText([
  { text: "External validity: ", options: { bullet: true, bold: true, breakLine: false } },
  { text: "program was implemented in three U.S. counties; generalizability to other settings requires caution.", options: { breakLine: true } },
  { text: "Partial identification: ", options: { bullet: true, bold: true, breakLine: false } },
  { text: "earnings records unavailable for 11% of cohort (attrition analysis → Appendix D).", options: { breakLine: true } },
], {
  x: MARGIN, y: 3.4, w: 9.0, h: 1.3,
  fontSize: FONTS.body, fontFace: FONTS.face, color: COLORS.body,
  paraSpaceAfter: 10
});
```

---

## 7. Conclusions Slide

**Purpose:** Restate the 2–4 key takeaways. **This slide stays on screen for the entire Q&A.**

Do not follow it with "Thank You," a blank slide, or a transition to appendix slides during Q&A.

```javascript
// Dark background treatment — mirrors the title slide (sandwich structure)
slide.background = { color: COLORS.primary };

// Action title stating the overall conclusion (not a bare "Conclusions" label)
slide.addText("Early intervention raises adult earnings most for the poorest children", {
  x: MARGIN, y: 0.25, w: 9.0, h: 0.5,
  fontSize: FONTS.title, fontFace: FONTS.face, color: "FFFFFF", bold: true, align: "left"
});


// Key takeaways — numbered for easy reference during Q&A
slide.addText([
  { text: "1. Early childhood effects are persistent: ", options: { bold: true, breakLine: false } },
  { text: "a significant earnings premium is detectable at age 35, 30 years after treatment.", options: { breakLine: true } },
  { text: "2. Effects are largest for the most disadvantaged: ", options: { bold: true, breakLine: false } },
  { text: "the Q1 earnings premium (28%) is 3.5× the Q4 effect (8%).", options: { breakLine: true } },
  { text: "3. The pathway is cognitive, not schooling-mediated: ", options: { bold: true, breakLine: false } },
  { text: "consistent with skill complementarity models.", options: { breakLine: true } },
], {
  x: MARGIN, y: 0.85, w: 9.0, h: 3.5,
  fontSize: FONTS.body + 1, fontFace: FONTS.face, color: "FFFFFF",
  paraSpaceAfter: 20
});

// Contact + link (this slide stays up during Q&A, so the contact is read here, not on a slide after it)
slide.addText("<author email>  |  Working paper: <short link>", {
  x: MARGIN, y: 4.8, w: 7.0, h: 0.4,
  fontSize: 14, fontFace: FONTS.face, color: "FFFFFF", align: "left"
});

// Optional QR code (add as image)
// slide.addImage({ path: "qr_preprint.png", x: 8.5, y: 4.5, w: 0.9, h: 0.9 });
```

---

## 8. Section Divider (for decks > 15 slides)

**Purpose:** Orient the audience at the start of each major section.

```javascript
// Use same dark treatment as title/conclusions — the palette's primary, no extra navy
slide.background = { color: COLORS.primary };

// Section number / label
slide.addText("Part 2", {
  x: MARGIN, y: 1.8, w: 9.0, h: 0.4,
  fontSize: FONTS.sectionHeader, fontFace: FONTS.face, color: "FFFFFF", bold: false, align: "left"
});

// Section title
slide.addText("Empirical Strategy", {
  x: MARGIN, y: 2.2, w: 9.0, h: 1.0,
  fontSize: 36, fontFace: FONTS.face, color: "FFFFFF", bold: true, align: "left"
});

```

---

## 9. Breadcrumb Row (optional, for long talks)

A persistent row of section labels at the top of each content slide: labels only, no fill and no underline, since decoration is out. Add to every content slide for talks > 15 minutes.

```javascript
// Add to each slide after the title/divider set
const sections = ["Motivation", "Data", "Strategy", "Results", "Discussion"];
const currentSection = "Results";  // Changes per slide

const rowY = 0.0;
const rowH = 0.28;

// Section labels — the active one takes the accent colour and bold weight, nothing else
const sectionW = 10 / sections.length;
sections.forEach((section, i) => {
  const isActive = section === currentSection;
  slide.addText(section, {
    x: i * sectionW, y: rowY, w: sectionW, h: rowH,
    fontSize: FONTS.cite, fontFace: FONTS.face,
    color: isActive ? COLORS.accent : COLORS.muted,
    bold: isActive,
    align: "center", valign: "middle"
  });
});

// Shift all other content down by rowH to avoid collision
// (adjust y coordinates in the rest of the slide by +rowH)
```

---

## 10. References Slide

**Purpose:** Complete citations for all sources cited in the deck. Required.

```javascript
slide.background = { color: COLORS.bg };

slide.addText("References", {
  x: MARGIN, y: 0.2, w: 9.0, h: 0.5,
  fontSize: FONTS.title, fontFace: FONTS.face, color: COLORS.primary, bold: true
});


const refs = [
  "Cunha, F. & Heckman, J.J. (2007). The Technology of Skill Formation. American Economic Review, 97(2), 31–47.",
  "Heckman, J.J., Moon, S.H., Pinto, R., Savelyev, P.A., & Yavitz, A. (2013). The Rate of Return to the HighScope Perry Preschool Program. Journal of Public Economics, 94(1), 114–128.",
  "Smith, J. & Doe, J. (2025). Long-Run Returns to Early Childhood Intervention: Evidence from a Randomized Trial. Working paper.",
];

const refItems = refs.flatMap((r, i) => [
  { text: r, options: { breakLine: true } },
  ...(i < refs.length - 1 ? [{ text: "", options: { breakLine: true } }] : [])
]);

slide.addText(refItems, {
  x: MARGIN, y: 0.85, w: 9.0, h: 4.5,
  fontSize: FONTS.cite, fontFace: FONTS.face, color: COLORS.body,
  paraSpaceAfter: 8
});
```

---

## 11. Appendix Slide

**Purpose:** Pre-built answer slides. Label clearly so they can be navigated to quickly during Q&A.

```javascript
// Appendix label — muted to distinguish from main deck
slide.addText("Appendix B — Robustness Checks", {
  x: MARGIN, y: 0.15, w: 9.0, h: 0.4,
  fontSize: 14, fontFace: FONTS.face, color: COLORS.muted, bold: false, italics: true
});

// Action title (still required — appendix slides also use action titles)
slide.addText("Earnings effect is stable across bandwidth choices and polynomial specifications", {
  x: MARGIN, y: 0.6, w: 9.0, h: 0.75,
  fontSize: FONTS.title, fontFace: FONTS.face, color: COLORS.primary, bold: true
});

// Content follows normal slide patterns
```

---

## Quick Checks Before Delivery

```
□ Title slide: full title as statement/question, author, affiliation, venue, date
□ Every content slide: action title (complete sentence, states takeaway)
□ Ghost deck test: titles alone tell the complete argument
□ Results slides: one exhibit each, key finding annotated on the chart
□ Every borrowed figure/data point: in-slide citation
□ References slide: complete, consistently formatted
□ Conclusions slide: last main slide, stays on screen during Q&A
□ Contact info / QR code on the conclusions slide
□ Body text ≥ 20 pt throughout
□ No slide has > ~40 words of body text
□ Appendix slides labeled, with pre-built Q&A answers
□ Deck runs 1–2 minutes under the time limit when practiced aloud
```
