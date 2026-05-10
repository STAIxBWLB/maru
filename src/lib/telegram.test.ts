import { describe, expect, it } from "vitest";
import { normalizeAnchorSettings } from "./settings";
import { telegramLoginCommand } from "./telegram";

describe("telegramLoginCommand", () => {
  it("runs through the user shell and expands tilde paths before quoting", () => {
    const settings = normalizeAnchorSettings({
      comms: {
        telegram: {
          pythonPath: "~/.anchor/env/.venv/bin/python",
          scriptPath:
            "~/.anchor/skills/_builtin/skills/io-telegram/scripts/telegram_monitor.py",
          sessionFile: "~/.anchor/telegram/monitor.session",
          monitorConfigPath:
            "~/workspace/work/.secrets/services/telegram-monitor.config.yaml",
        },
      },
    }).comms.telegram;

    const command = telegramLoginCommand(settings);

    expect(command.command).toBeNull();
    expect(command.args[0]).toBe("-lc");
    expect(command.args[1]).toContain(
      '"$HOME/.anchor/env/.venv/bin/python"',
    );
    expect(command.args[1]).toContain(
      '"$HOME/.anchor/skills/_builtin/skills/io-telegram/scripts/auth.py"',
    );
    expect(command.args[1]).toContain(
      '--session-file "$HOME/.anchor/telegram/monitor.session"',
    );
    expect(command.args[1]).toContain(
      '--config-file "$HOME/workspace/work/.secrets/services/telegram-monitor.config.yaml"',
    );
  });
});
