// D-05's assertion pair for terminal-facing native specs: an exact text
// mirror of the terminal screen grid (through the build-gated debug bridge
// from src/lib/nativeE2eBridge.ts) and a pixel readback proving the canvas
// region was painted. The two prove different facts — the text mirror says
// *what* the terminal printed; the ink check says the region *painted* —
// and neither depends on golden screenshots, font rendering, or
// devicePixelRatio (D-05 rejects all three).
//
// Type-only: pulls in webdriverio's WebdriverIO.Browser augmentation so the
// ambient `browser` global has the execute/$ command surface (same note as
// e2e-native/specs/webview.spec.ts).
import type {} from "webdriverio";

/** Channel tolerance for the ink check: absorbs subpixel antialiasing on a
 *  Retina runner so a genuinely painted glyph edge never reads as background,
 *  without letting a uniform fill count as ink. */
export const INK_CHANNEL_TOLERANCE = 8;

/** Minimum differing-pixel ratio: low enough that a single short line of
 *  text clears it, while an entirely unpainted or uniformly filled canvas
 *  returns zero. */
export const INK_MIN_RATIO = 0.002;

/** The bridge global's shape, re-declared locally: tsconfig.e2e-native.json
 *  does not include src/, so the Window augmentation in
 *  src/lib/nativeE2eBridge.ts is not visible here. */
interface MaruNativeE2eBridge {
  terminalText(sessionId: string): string | null;
  menuCommand(id: string): void;
}

declare global {
  interface Window {
    __MARU_NATIVE_E2E__?: MaruNativeE2eBridge;
  }
}

/** Reads the terminal's whole screen as exact text through the debug bridge.
 *  Returns null when the session id is not (or no longer) registered. Throws
 *  when the bridge namespace itself is missing — that means the app is
 *  serving a frontend built without the runner flag, and naming
 *  `pnpm build:frontend:native-e2e` is worth more than "expected string, got
 *  null". */
export async function readTerminalText(sessionId: string): Promise<string | null> {
  const probe = await browser.execute((id: string) => {
    const namespace = window.__MARU_NATIVE_E2E__;
    return { present: Boolean(namespace), text: namespace?.terminalText(id) ?? null };
  }, sessionId);
  if (!probe.present) {
    throw new Error(
      "readTerminalText: window.__MARU_NATIVE_E2E__ is absent — the app is " +
        "serving a frontend built without the runner flag. Rebuild with " +
        "`pnpm build:frontend:native-e2e` (or run `make test-e2e-native`, " +
        "which builds it for you) before running this spec.",
    );
  }
  return probe.text;
}

export interface TerminalInkOptions {
  channelTolerance?: number;
  minRatio?: number;
}

/** Asserts the matched terminal canvas was actually painted, independently
 *  of what the text mirror says. The background is derived empirically — the
 *  most frequent RGBA quadruple in the sample — so the check reads no
 *  palette, theme attribute, or CSS variable and is independent of
 *  `data-terminal-theme`, of the runner's colour profile, and of the font.
 *
 *  The canvas paints via fillText/fillRect, never drawImage from an external
 *  source, so getImageData is not subject to cross-origin tainting whatever
 *  origin Tauri's custom protocol serves. A SecurityError here would be a
 *  real regression in how the terminal paints — it is deliberately not
 *  caught. */
export async function assertTerminalInk(
  canvasSelector: string,
  options: TerminalInkOptions = {},
): Promise<void> {
  const channelTolerance = options.channelTolerance ?? INK_CHANNEL_TOLERANCE;
  const minRatio = options.minRatio ?? INK_MIN_RATIO;
  const sample = await browser.execute(
    (selector: string, tolerance: number) => {
      const canvas = document.querySelector<HTMLCanvasElement>(selector);
      if (!canvas) {
        throw new Error(`assertTerminalInk: no canvas matches "${selector}"`);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error(`assertTerminalInk: 2D context unavailable for "${selector}"`);
      }
      // Sample in device pixels from canvas.width/height — never CSS geometry
      // (getBoundingClientRect) — so the rectangle follows devicePixelRatio
      // instead of fighting it: full width, top 25% of the canvas.
      const width = canvas.width;
      const height = Math.max(1, Math.floor(canvas.height * 0.25));
      const { data } = ctx.getImageData(0, 0, width, height);

      const histogram = new Map<string, number>();
      for (let i = 0; i < data.length; i += 4) {
        const key = `${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`;
        histogram.set(key, (histogram.get(key) ?? 0) + 1);
      }
      let background = "";
      let backgroundCount = -1;
      for (const [key, count] of histogram) {
        if (count > backgroundCount) {
          background = key;
          backgroundCount = count;
        }
      }
      const [r, g, b, a] = background.split(",").map(Number);

      let ink = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (
          Math.abs(data[i] - r) > tolerance ||
          Math.abs(data[i + 1] - g) > tolerance ||
          Math.abs(data[i + 2] - b) > tolerance ||
          Math.abs(data[i + 3] - a) > tolerance
        ) {
          ink += 1;
        }
      }
      return { ink, total: data.length / 4 };
    },
    canvasSelector,
    channelTolerance,
  );
  const ratio = sample.total === 0 ? 0 : sample.ink / sample.total;
  if (ratio < minRatio) {
    throw new Error(
      `assertTerminalInk: "${canvasSelector}" shows no paint — ` +
        `${sample.ink}/${sample.total} sampled pixels differ from the sampled ` +
        `background (ratio ${ratio.toFixed(5)} < ${minRatio}). The terminal ` +
        "canvas was never painted, or was painted uniformly.",
    );
  }
}
