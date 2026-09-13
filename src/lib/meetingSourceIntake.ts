import type { MeetingSource, SourceDraft } from "./meetingSources";

export type SelectedMeetingFile = Pick<File, "name" | "size" | "arrayBuffer">;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

function validateName(name: string): void {
  if (!/\.(txt|md|markdown)$/i.test(name)) throw new Error(`Unsupported meeting source: ${name}. Use TXT or Markdown.`);
}
function validateText(name: string, text: string): void {
  if (!text.trim()) throw new Error(`Empty meeting source: ${name}`);
  if (new TextEncoder().encode(text).byteLength > MAX_SOURCE_BYTES) throw new Error(`Meeting source exceeds 2 MiB: ${name}`);
}

/** Read and validate the entire intake before the caller makes one durable create. */
export async function prepareMeetingSourceIntake({
  title, prompt, pastedText, files, contextPaths, readContext,
}: {
  title: string;
  prompt: string;
  pastedText: string;
  files: SelectedMeetingFile[];
  contextPaths: string[];
  readContext: (path: string) => Promise<string>;
}): Promise<SourceDraft | null> {
  const paths = [...new Set(contextPaths)];
  for (const file of files) {
    validateName(file.name);
    if (file.size > MAX_SOURCE_BYTES) throw new Error(`Meeting source exceeds 2 MiB: ${file.name}`);
  }
  for (const path of paths) validateName(path);
  if (pastedText.trim()) validateText(title, pastedText);

  const selected = await Promise.all(files.map(async (file) => {
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error(`Meeting source exceeds 2 MiB: ${file.name}`);
    // Browser-granted File objects work for Downloads and other external
    // locations without exposing unrestricted filesystem reads through IPC.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    validateText(file.name, text);
    return { name: file.name, text };
  }));
  const context = await Promise.all(paths.map(async (path) => {
    const text = await readContext(path);
    validateText(path, text);
    return { name: path.split(/[\\/]/).at(-1) ?? path, text };
  }));
  const inputs = [
    ...(pastedText.trim() ? [{ name: title, text: pastedText }] : []),
    ...selected, ...context,
  ];
  if (!inputs.length) return null;
  const sources: MeetingSource[] = inputs.map(({ name, text }) => ({
    id: crypto.randomUUID(), name, kind: "note", text, originalText: text, originalHash: "",
  }));
  return {
    title: pastedText.trim() ? title : inputs[0].name,
    provider: "External", context: prompt, sources,
    participants: [], findings: [], suggestions: [], participantsReviewed: false, noteReviewed: false,
  };
}
