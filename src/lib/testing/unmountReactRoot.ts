import { act } from "react";
import type { Root } from "react-dom/client";

/** Finish deferred Radix FocusScope disposal before its jsdom realm closes. */
export async function unmountReactRoot(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}
