export type EngineIdentity = { id: string, version: string, revision: string, };

export type ReceiptGate = { status: string, scope: string, };

export type ReceiptGates = { schema: ReceiptGate, artifact: ReceiptGate, browser: ReceiptGate, visualReview: ReceiptGate, };

export type ReceiptConversion = { format: string, theme: string, pixelRatio: number, };

export type EngineReceipt = { schemaVersion: number, inputSpecSha256: string, engine: EngineIdentity, engineOutputSha256?: string | null, conversion?: ReceiptConversion | null, outputSha256?: string | null, outputMimeType?: string | null, gates: ReceiptGates, readback?: ReceiptGate | null, docId?: string | null, documentName?: string | null, documentRevision?: string | null, renderedAt?: string | null, diagramType?: string | null, datasetId?: string | null, };

export type Diagnostic = { code: string, path: string, rule: string, message: string, fix: string, };

export type ValidationReport = { apiVersion: number, ok: boolean, diagnostics: Array<Diagnostic>, receipt: EngineReceipt, };

export type ArchitectureMeta = { title: string, output: string, locale: string | null, };

export type ArchitectureLayout = { mode: string, cols: number | null, };

export type ArchitectureComponent = { id: string, type: string, label: string, row: number | null, col: number | null, };

export type ArchitectureConnection = { id: string | null, from: string, to: string, label: string | null, };

export type ArchitectureBoundary = { kind: string, label: string, wraps: Array<string>, };

export type ArchitectureSpec = { schema_version: number, diagram_type: string, meta: ArchitectureMeta, layout: ArchitectureLayout | null, components: Array<ArchitectureComponent>, connections: Array<ArchitectureConnection>, boundaries: Array<ArchitectureBoundary>, };