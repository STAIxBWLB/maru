import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import { Button } from "./Button";
import { TextInput } from "./Field";

interface TextPrompt {
  message: string;
  value: string;
}

/**
 * In-app stand-in for the browser's prompt(), which wry never shows in the app
 * (it returns null at once, #377). Same shape as useApprovalGate: render
 * `dialog` once, and `askText` resolves the typed text, or null on Cancel.
 */
export function useTextPrompt() {
  const [prompt, setPrompt] = useState<TextPrompt | null>(null);
  const resolveRef = useRef<((value: string | null) => void) | null>(null);

  const settle = useCallback((value: string | null) => {
    resolveRef.current?.(value);
    resolveRef.current = null;
    setPrompt(null);
  }, []);

  const askText = useCallback((message: string, defaultValue = "") => {
    // A newer ask replaces an open one, which answers Cancel.
    resolveRef.current?.(null);
    setPrompt({ message, value: defaultValue });
    return new Promise<string | null>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  // An unmount with the field open answers Cancel instead of hanging the caller.
  useEffect(() => () => resolveRef.current?.(null), []);

  // A child component, so the hook also works in the component that provides
  // the locale (MainApp), as useApprovalGate's dialog does.
  const dialog = <TextPromptDialog prompt={prompt} onChange={setPrompt} onSettle={settle} />;
  return { askText, dialog };
}

// WebKit can clear isComposing before the key that ends the composition, so
// keyCode 229 (the IME's process key) counts too.
function isComposingKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

function TextPromptDialog({
  prompt,
  onChange,
  onSettle,
}: {
  prompt: TextPrompt | null;
  onChange: (prompt: TextPrompt) => void;
  onSettle: (value: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open) onSettle(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          asChild
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            // An Escape that ends an IME composition must not close the field.
            if (isComposingKey(event)) event.preventDefault();
          }}
        >
          <form
            className="dialog-content"
            onSubmit={(event) => {
              event.preventDefault();
              if (prompt) onSettle(prompt.value);
            }}
          >
            <div className="dialog-header">
              <Dialog.Title>{prompt?.message}</Dialog.Title>
            </div>
            <TextInput
              aria-label={prompt?.message}
              value={prompt?.value ?? ""}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                // The Enter that commits a Korean composition must not also
                // submit the field.
                if (event.key === "Enter" && isComposingKey(event.nativeEvent)) event.preventDefault();
              }}
              onChange={(event) => {
                if (prompt) onChange({ ...prompt, value: event.target.value });
              }}
            />
            <div className="dialog-actions">
              <Button type="button" variant="ghost" onClick={() => onSettle(null)}>
                {t("dialog.cancel")}
              </Button>
              <Button type="submit">{t("dialog.ok")}</Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
