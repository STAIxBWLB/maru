/**
 * Synthetic report-table fixtures.
 *
 * Six invented report structures inspired by development-cooperation
 * documents (PDM, KPI scorecard, budget execution, schedule, RACI, strategy
 * cascade). All content is synthetic - no real project data. Phase 1 feeds
 * these into the typed matrix model; for now they are plain typed data plus a
 * smoke test that validates structural invariants (rectangular rows after
 * span expansion, positive spans, non-empty text).
 *
 * Span convention: a cell with `colSpan: n` covers n columns; a cell with
 * `rowSpan: n` covers n rows, and the rows below simply omit the covered
 * cell (so `rowWidth` of every row still equals `columns.length`).
 */

export type ReportTableKind =
  | "pdm"
  | "kpi-scorecard"
  | "budget"
  | "schedule"
  | "raci"
  | "strategy-cascade";

export interface ReportCell {
  text: string;
  rowSpan?: number;
  colSpan?: number;
}

export interface ReportTableFixture {
  kind: ReportTableKind;
  title: string;
  columns: string[];
  rows: ReportCell[][];
}

/** Effective column width of a row after expanding colSpans. */
export function rowWidth(row: ReportCell[]): number {
  return row.reduce((sum, cell) => sum + (cell.colSpan ?? 1), 0);
}

// ---------------------------------------------------------------------------
// 1. PDM (Project Design Matrix) - goal/purpose/outputs/activities with
//    merged indicator cells.
// ---------------------------------------------------------------------------

const pdmFixture: ReportTableFixture = {
  kind: "pdm",
  title: "Synthetic PDM - Rural Digital Literacy Program",
  columns: ["Narrative Summary", "Objectively Verifiable Indicators", "Means of Verification", "Assumptions"],
  rows: [
    [
      { text: "Goal: Improved employability of rural youth (region X)" },
      { text: "Employment rate of graduates rises from 41% to 60% by 2029" },
      { text: "Regional labor statistics (annual)" },
      { text: "Regional economy remains stable" },
    ],
    [
      { text: "Purpose: 500 trainees complete certified digital-literacy tracks" },
      { text: "Completion rate >= 85%; certification pass rate >= 70%", rowSpan: 2 },
      { text: "Training center records; exam board results", rowSpan: 2 },
      { text: "Certification body remains accredited" },
    ],
    [
      { text: "Output 1: 20 instructors trained and deployed" },
      // indicator + MoV merged from the row above (rowSpan: 2)
      { text: "Instructor attrition stays below 15%" },
    ],
    [
      { text: "Output 2: 12 community learning hubs equipped" },
      { text: "All hubs operational by Q3 2027" },
      { text: "Hub acceptance inspection reports" },
      { text: "Local partners provide venues" },
    ],
    [
      { text: "Activities: curriculum design, instructor ToT, hub fit-out, enrollment drives" },
      { text: "Budget execution >= 90% per semester" },
      { text: "Quarterly financial reports" },
      { text: "Timely disbursement of tranches" },
    ],
  ],
};

// ---------------------------------------------------------------------------
// 2. KPI achievement scorecard - target/actual/status/evidence.
// ---------------------------------------------------------------------------

const kpiFixture: ReportTableFixture = {
  kind: "kpi-scorecard",
  title: "Synthetic KPI Scorecard - FY2028",
  columns: ["KPI", "Baseline", "Target", "Actual", "Status", "Evidence"],
  rows: [
    [
      { text: "Trainees enrolled (cumulative)" },
      { text: "0" },
      { text: "500" },
      { text: "472" },
      { text: "On track" },
      { text: "Enrollment ledger export 2028-06" },
    ],
    [
      { text: "Certification pass rate" },
      { text: "-" },
      { text: "70%" },
      { text: "74%" },
      { text: "Achieved" },
      { text: "Exam board transcript summary" },
    ],
    [
      { text: "Hub uptime (monthly avg)" },
      { text: "-" },
      { text: "95%" },
      { text: "88%" },
      { text: "At risk" },
      { text: "Hub monitoring dashboard logs" },
    ],
    [
      { text: "Graduate employment within 6 months" },
      { text: "41%" },
      { text: "55%" },
      { text: "49%" },
      { text: "Delayed" },
      { text: "Tracer study wave 2 (n=180)" },
    ],
  ],
};

// ---------------------------------------------------------------------------
// 3. Budget plan vs execution - 3-level hierarchy with subtotals.
// ---------------------------------------------------------------------------

const budgetFixture: ReportTableFixture = {
  kind: "budget",
  title: "Synthetic Budget - Plan vs Execution (USD)",
  columns: ["Line Item", "Planned", "Executed", "Execution Rate", "Note"],
  rows: [
    [{ text: "1. Personnel", colSpan: 5 }],
    [
      { text: "1.1 Instructors (20 x 24 months)" },
      { text: "180,000" },
      { text: "168,000" },
      { text: "93.3%" },
      { text: "Two vacancies in Q1" },
    ],
    [
      { text: "1.1.1 Instructor overtime allowance" },
      { text: "12,000" },
      { text: "9,400" },
      { text: "78.3%" },
      { text: "Included in 1.1" },
    ],
    [
      { text: "1.2 Program coordination" },
      { text: "60,000" },
      { text: "53,500" },
      { text: "89.2%" },
      { text: "" },
    ],
    [
      { text: "Subtotal: Personnel" },
      { text: "240,000" },
      { text: "221,500" },
      { text: "92.3%" },
      { text: "" },
    ],
    [{ text: "2. Equipment", colSpan: 5 }],
    [
      { text: "2.1 Hub fit-out (12 sites)" },
      { text: "150,000" },
      { text: "149,200" },
      { text: "99.5%" },
      { text: "Procurement complete" },
    ],
    [
      { text: "Subtotal: Equipment" },
      { text: "150,000" },
      { text: "149,200" },
      { text: "99.5%" },
      { text: "" },
    ],
    [{ text: "3. Operations", colSpan: 5 }],
    [
      { text: "3.1 Local travel and venue costs" },
      { text: "90,000" },
      { text: "71,800" },
      { text: "79.8%" },
      { text: "Travel below plan" },
    ],
    [
      { text: "Subtotal: Operations" },
      { text: "90,000" },
      { text: "71,800" },
      { text: "79.8%" },
      { text: "" },
    ],
    [
      { text: "Total" },
      { text: "480,000" },
      { text: "442,500" },
      { text: "92.2%" },
      { text: "Within tolerance band" },
    ],
  ],
};

// ---------------------------------------------------------------------------
// 4. 24-period schedule - phases x quarters with span bars.
// ---------------------------------------------------------------------------

const schedulePeriods = Array.from({ length: 24 }, (_, i) => `M${i + 1}`);

function bar(startInclusive: number, length: number): ReportCell[] {
  const cells: ReportCell[] = [];
  for (let i = 1; i < startInclusive; i += 1) cells.push({ text: "" });
  cells.push({ text: `M${startInclusive}-M${startInclusive + length - 1}`, colSpan: length });
  for (let i = startInclusive + length; i <= 24; i += 1) cells.push({ text: "" });
  return cells;
}

const scheduleFixture: ReportTableFixture = {
  kind: "schedule",
  title: "Synthetic Implementation Schedule - 24 Months",
  columns: ["Phase", "Activity", ...schedulePeriods],
  rows: [
    [
      { text: "Phase 1: Inception", rowSpan: 2 },
      { text: "Baseline survey and curriculum design" },
      ...bar(1, 6),
    ],
    [
      { text: "Instructor recruitment and ToT" },
      ...bar(4, 6),
    ],
    [
      { text: "Phase 2: Rollout", rowSpan: 2 },
      { text: "Hub fit-out and equipment installation" },
      ...bar(7, 8),
    ],
    [
      { text: "Cohort 1-3 training cycles" },
      ...bar(10, 12),
    ],
    [
      { text: "Phase 3: Closure", rowSpan: 2 },
      { text: "Certification exams and tracer study" },
      ...bar(19, 4),
    ],
    [
      { text: "Final evaluation and handover" },
      ...bar(22, 3),
    ],
  ],
};

// ---------------------------------------------------------------------------
// 5. RACI matrix.
// ---------------------------------------------------------------------------

const raciFixture: ReportTableFixture = {
  kind: "raci",
  title: "Synthetic RACI - Program Governance",
  columns: ["Deliverable", "Donor", "PMU", "Implementing Partner", "Local Gov", "Consultant"],
  rows: [
    [
      { text: "Curriculum approved" },
      { text: "A" },
      { text: "R" },
      { text: "C" },
      { text: "C" },
      { text: "R" },
    ],
    [
      { text: "Hub sites selected" },
      { text: "I" },
      { text: "C" },
      { text: "R" },
      { text: "A" },
      { text: "I" },
    ],
    [
      { text: "Quarterly progress report" },
      { text: "A" },
      { text: "R" },
      { text: "C" },
      { text: "I" },
      { text: "I" },
    ],
    [
      { text: "Mid-term review" },
      { text: "A" },
      { text: "C" },
      { text: "C" },
      { text: "I" },
      { text: "R" },
    ],
    [
      { text: "Assets handed over" },
      { text: "I" },
      { text: "R" },
      { text: "C" },
      { text: "A" },
      { text: "I" },
    ],
  ],
};

// ---------------------------------------------------------------------------
// 6. Strategy cascade - hierarchy from vision to team actions.
// ---------------------------------------------------------------------------

const strategyFixture: ReportTableFixture = {
  kind: "strategy-cascade",
  title: "Synthetic Strategy Cascade",
  columns: ["Level", "Statement", "Owner", "Time Horizon", "Linked KPI"],
  rows: [
    [
      { text: "Vision" },
      { text: "Digitally confident rural workforce by 2030" },
      { text: "Steering committee" },
      { text: "5 years" },
      { text: "Employment rate" },
    ],
    [
      { text: "Strategic objective" },
      { text: "Scale certified digital-literacy training to 3 regions" },
      { text: "Program director" },
      { text: "3 years" },
      { text: "Trainees certified" },
    ],
    [
      { text: "Initiative" },
      { text: "Community learning hub network" },
      { text: "PMU lead" },
      { text: "24 months" },
      { text: "Hubs operational" },
    ],
    [
      { text: "Team action" },
      { text: "Fit-out 12 hubs; train 20 instructors" },
      { text: "Operations team" },
      { text: "12 months" },
      { text: "Instructors deployed" },
    ],
  ],
};

export const reportFixtures: ReportTableFixture[] = [
  pdmFixture,
  kpiFixture,
  budgetFixture,
  scheduleFixture,
  raciFixture,
  strategyFixture,
];
