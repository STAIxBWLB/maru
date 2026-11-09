export type EngineIdentity = { id: string, version: string, revision: string, };

export type ReceiptGate = { status: string, scope: string, };

export type ReceiptGates = { schema: ReceiptGate, artifact: ReceiptGate, browser: ReceiptGate, visualReview: ReceiptGate, };

export type ReceiptConversion = { format: string, theme: string, pixelRatio: number, };

export type EngineReceipt = { schemaVersion: number, inputSpecSha256: string, engine: EngineIdentity, engineOutputSha256?: string | null, conversion?: ReceiptConversion | null, outputSha256?: string | null, outputMimeType?: string | null, gates: ReceiptGates, readback?: ReceiptGate | null, docId?: string | null, documentName?: string | null, documentRevision?: string | null, renderedAt?: string | null, diagramType?: string | null, datasetId?: string | null, };

export type Diagnostic = { code: string, path: string, rule: string, message: string, fix: string, };

export type ValidationReport = { apiVersion: number, ok: boolean, diagnostics: Array<Diagnostic>, receipt: EngineReceipt, };

export type ArchitectureMeta = { title: string, output: string, locale?: string | null, translations?: { [key in string]: string } | null, subtitle?: string | null, animation?: string | null, visual_preset?: string | null, quality_profile?: string | null, engineering_profile?: string | null, column_fit?: string | null, repository?: Repository | null, views?: Array<GuidedView> | null, legend?: Legend | null, viewBox?: [number, number] | null, };

export type Repository = { url: string, revision: string, provider?: string | null, link_mode?: string | null, };

export type GuidedView = { id: string, label: string, focus: Array<string>, note?: string | null, };

export type Legend = { mode?: string | null, entries?: { [key in string]: LegendEntry } | null, };

export type LegendEntry = { label?: string | null, visible?: boolean | null, };

export type Card = { dot: string, title: string, items: Array<string>, };

export type Decoration = { sublabel?: string | null, tag?: string | null, icon?: string | null, brand?: Brand | null, sources?: Array<SourceReference> | null, };

export type Brand = string | PinnedBrand;

export type PinnedBrand = { url: string, sha256: string, };

export type SourceReference = { path: string, line?: number | null, end_line?: number | null, label?: string | null, };

export type ArchitectureSpec = { schema_version: number, diagram_type: string, meta: ArchitectureMeta, layout?: ArchitectureLayout | null, components: Array<ArchitectureComponent>, connections?: Array<ArchitectureConnection>, boundaries?: Array<ArchitectureBoundary>, cards?: Array<Card>, };

export type ArchitectureLayout = { mode: string, origin?: [number, number] | null, cols?: number | null, gapX?: number | null, gapY?: number | null, cellW?: number | null, cellH?: number | null, };

export type ArchitectureComponent = { id: string, type: string, label: string, row?: number | null, col?: number | null, pos?: [number, number] | null, size?: [number, number] | null, sublabel?: string | null, tag?: string | null, icon?: string | null, brand?: Brand | null, sources?: Array<SourceReference> | null, };

export type ArchitectureBoundary = { kind: string, label: string, wraps: Array<string>, pad?: number | null, };

export type ArchitectureConnection = { id?: string | null, from: string, to: string, label?: string | null, variant?: string | null, fromSide?: string | null, toSide?: string | null, route?: string | null, via?: Array<[number, number]> | null, labelAt?: [number, number] | null, labelDx?: number | null, labelDy?: number | null, labelSegment?: number | null, width?: number | null, };

export type WorkflowSpec = { schema_version: number, diagram_type: string, meta: ArchitectureMeta, lanes: Array<WorkflowLane>, phases?: Array<WorkflowPhase> | null, groups?: Array<WorkflowGroup> | null, mainPath?: Array<string> | null, semanticChecks?: WorkflowSemanticChecks | null, nodes: Array<WorkflowNode>, edges: Array<WorkflowEdge>, cards?: Array<Card> | null, };

export type WorkflowLane = { id: string, label: string, variant?: string | null, };

export type WorkflowPhase = { id: string, label: string, fromCol: number, toCol: number, variant?: string | null, };

export type WorkflowGroup = { id: string, label: string, lane: string, fromCol: number, toCol: number, variant?: string | null, };

export type WorkflowNode = { id: string, lane: string, col: number, type: string, label: string, sublabel?: string | null, tag?: string | null, icon?: string | null, brand?: Brand | null, sources?: Array<SourceReference> | null, width?: number | null, height?: number | null, yOffset?: number | null, };

export type WorkflowEdge = { id?: string | null, from: string, to: string, label?: string | null, variant?: string | null, role?: string | null, fromSide?: string | null, toSide?: string | null, route?: string | null, via?: Array<[number, number]> | null, labelAt?: [number, number] | null, labelDx?: number | null, labelDy?: number | null, labelSegment?: number | null, channelX?: number | null, channelY?: number | null, bias?: number | null, width?: number | null, };

export type WorkflowSemanticRelation = { from: string, to: string, };

export type WorkflowSemanticChecks = { allowedRoots?: Array<string> | null, allowedTerminals?: Array<string> | null, requiredEdges?: Array<WorkflowSemanticRelation> | null, requiredPaths?: Array<WorkflowSemanticRelation> | null, };

export type SequenceParticipant = { id: string, type: string, label: string, sublabel?: string | null, tag?: string | null, icon?: string | null, brand?: Brand | null, sources?: Array<SourceReference> | null, };

export type SequenceMessage = { id?: string | null, from: string, to: string, y: number, label: string, variant?: string | null, note?: string | null, };

export type SequenceSegment = { from: number, to: number, label: string, };

export type SequenceActivation = { participant: string, from: number, to: number, type?: string | null, };

export type SequenceSpec = { schema_version: number, diagram_type: string, meta: ArchitectureMeta, participants: Array<SequenceParticipant>, messages: Array<SequenceMessage>, segments?: Array<SequenceSegment>, activations?: Array<SequenceActivation>, cards?: Array<Card>, };

export type DataflowStage = { label: string, };

export type DataflowNode = { id: string, type: string, label: string, stage: number, row: number, width?: number | null, height?: number | null, yOffset?: number | null, sublabel?: string | null, tag?: string | null, icon?: string | null, brand?: Brand | null, sources?: Array<SourceReference> | null, };

export type DataflowFlow = { id?: string | null, from: string, to: string, label: string, classification?: string | null, variant?: string | null, route?: string | null, fromSide?: string | null, toSide?: string | null, channelX?: number | null, channelY?: number | null, labelAt?: [number, number] | null, labelDx?: number | null, labelDy?: number | null, labelSegment?: number | null, via?: Array<[number, number]> | null, width?: number | null, };

export type DataflowSpec = { schema_version: number, diagram_type: string, meta: ArchitectureMeta, stages: Array<DataflowStage>, nodes: Array<DataflowNode>, flows: Array<DataflowFlow>, cards?: Array<Card>, };

export type LifecycleSpec = { schema_version: number, diagram_type: string, meta: ArchitectureMeta, lanes: Array<LifecycleLane>, states: Array<LifecycleState>, transitions: Array<LifecycleTransition>, cards?: Array<Card> | null, };

export type LifecycleLane = { id: string, label: string, };

export type LifecycleState = { id: string, type: string, label: string, sublabel?: string | null, tag?: string | null, icon?: string | null, brand?: Brand | null, sources?: Array<SourceReference> | null, step?: string | null, lane: string, col: number, width?: number | null, height?: number | null, yOffset?: number | null, };

export type LifecycleTransition = { id?: string | null, from: string, to: string, label?: string | null, note?: string | null, variant?: string | null, route?: string | null, fromSide?: string | null, toSide?: string | null, channelX?: number | null, channelY?: number | null, cornerRadius?: number | null, labelAt?: [number, number] | null, labelDx?: number | null, labelDy?: number | null, labelSegment?: number | null, via?: Array<[number, number]> | null, width?: number | null, };

export type GeometryTargetKind = "node" | "container";

export type GeometryPositionSource = "plannedPin" | "authoredPosition" | "automatic";

export type GeometryPoint = { x: number, y: number, };

export type GeometryBox = { x: number, y: number, width: number, height: number, };

export type FontIdentity = { id: string, revision: string, fontSha256: string, weight: number, unitsPerEm: number, license: string, };

export type GeometryNode = {
/**
 * Optional semantic classification; coordinates and API version are unchanged.
 */
finalState?: boolean | null,
/**
 * Authored main-lane column, for both versions, independent of pinned positions.
 */
phaseOrder?: number | null, id: string, bounds: GeometryBox,
/**
 * Future placement resolution order is planned pin, authored position,
 * then automatic placement.
 */
positionSource: GeometryPositionSource, };

export type GeometryContainer = { id: string, kind: string, bounds: GeometryBox, };

export type GeometryRoute = { id?: string | null, from: string, to: string, points: Array<GeometryPoint>, variant: string | null, role: string | null, width: number | null, };

export type GeometryGlyph = { glyphId: number, input: string, position: GeometryPoint, ink: GeometryBox, advance: number, ignored: boolean, replaced: boolean, };

export type GeometryLabel = { id?: string | null, targetId: string, text: string, bounds: GeometryBox, font: FontIdentity, fontSize: number, glyphs: Array<GeometryGlyph>, };

export type GeometryLegendEntry = { swatchBounds?: GeometryBox | null, textBounds?: GeometryBox | null, key: string, label: string, bounds: GeometryBox, };

export type GeometryLegend = {
/**
 * Invisible extent of every legend label and painted primitive.
 */
contentBounds?: GeometryBox | null, titleY?: number | null, bounds: GeometryBox, entries: Array<GeometryLegendEntry>, };

export type GeometryPage = { bounds: GeometryBox,
/**
 * Translation this page applies to the source drawing, so an emitted
 * position is `source + contentOffset`. It is present only when a family
 * draws its header inside the page (workflow, dataflow): every authored
 * coordinate stays in source space, so a consumer that turns an emitted
 * canvas position back into an authored one subtracts this offset
 * (`maru#561`). Absent fields read as (0,0).
 */
contentOffset?: GeometryPoint | null, };

export type GeometryLine = { from: GeometryPoint, to: GeometryPoint, };

export type GeometryDocument = { lifecycleRail?: GeometryLine | null, nodes: Array<GeometryNode>, containers: Array<GeometryContainer>, routes: Array<GeometryRoute>, labels: Array<GeometryLabel>, legend: GeometryLegend, page: GeometryPage, };

export type GeometryReport = { apiVersion: number, ok: boolean, geometry?: GeometryDocument | null, diagnostics: Array<Diagnostic>, receipt: EngineReceipt, };

export type LayoutRequest = { specJson: string, pinSet?: PinSet | null, };

export type PinSet = { sourceSpecSha256: string, pins?: Array<GeometryPin>, };

export type GeometryPin = { targetId: string, targetKind: GeometryTargetKind, position: GeometryPoint, role?: string | null, };

export type PinResolution = { pins: Array<GeometryPin>, sourceChanged: boolean, diagnostics: Array<Diagnostic>, };

export type GlyphPosition = {
/**
 * Original scalar, retained for attribution when replacement was needed.
 */
input: string,
/**
 * The mapped scalar, or empty when no Unicode mapping is claimed.
 * For nonignored .notdef entries, E3 renders glyph_id 0 directly.
 */
rendered: string, glyphId: number, position: GeometryPoint,
/**
 * Difference of rounded prefix advances, avoiding per-glyph drift.
 */
advance: number, leftSideBearing: number,
/**
 * Ink relative to the run baseline, with outward-rounded bounds.
 */
ink: GeometryBox, replaced: boolean,
/**
 * Default-ignorable input: skip drawing even though glyph_id is 0.
 */
ignored: boolean, };

export type TextMetrics = { font: FontIdentity,
/**
 * Requested size in 1/64 pixel units.
 */
size: number, advance: number,
/**
 * Empty runs and inkless runs have a zero box at the baseline origin.
 */
ink: GeometryBox, ascender: number,
/**
 * Signed, normally negative below the baseline.
 */
descender: number, lineGap: number, glyphs: Array<GlyphPosition>, replacements: number,
/**
 * Nonfatal replacement notices; successful metrics remain available.
 */
diagnostics: Array<Diagnostic>, };