/** Node-only test host matching archify.rs parse_receipt, never a browser bypass. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
interface ValidationReceipt {
  ok: boolean;
  errors: string[];
  warnings: string[];
  candidateSha256?: string;
}
interface EngineHost {
  validateCandidate(type: string, spec: unknown): Promise<ValidationReceipt>;
}

export const pinnedEngineHost: EngineHost = {
  validateCandidate: async (type, spec) => {
    const dir = mkdtempSync(join(tmpdir(), "maru-engine-host-"));
    try {
      const file = join(dir, "candidate.json");
      writeFileSync(file, JSON.stringify(spec));
      const result = spawnSync(process.execPath, ["sidecars/archify/bin/archify.mjs", "validate", type, file, "--json"], { encoding: "utf8", timeout: 10_000 });
      if (result.error) throw result.error;
      const receipt = JSON.parse(result.stdout) as {
        ok?: boolean; error?: string; candidate?: { sha256?: string };
        diagnostics?: Array<{ severity?: string; code?: string; message?: string }>;
      };
      const errors: string[] = [];
      const warnings: string[] = [];
      for (const item of receipt.diagnostics ?? []) {
        (item.severity === "error" ? errors : warnings).push(`${item.code ?? "diagnostic"}: ${(item.message ?? "").trim()}`);
      }
      if (!receipt.ok && errors.length === 0 && receipt.error) errors.push(receipt.error);
      return { ok: receipt.ok === true, errors, warnings, candidateSha256: receipt.candidate?.sha256 };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
};
