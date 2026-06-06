import { describe, expect, it } from "vitest";
import { normalizeAnchorSettings } from "./settings";
import {
  gwsAuthCommand,
  isTelegramMonitorConfigOutsideAnchor,
  m365LoginCommand,
  telegramLoginCommand,
} from "./telegram";

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

describe("provider reauth commands", () => {
  it("quotes explicit gws and m365 paths", () => {
    expect(gwsAuthCommand("/opt/homebrew/bin/gws").args[1]).toBe(
      "exec '/opt/homebrew/bin/gws' auth",
    );
    expect(m365LoginCommand("~/bin/m365").args[1]).toBe(
      'exec "$HOME/bin/m365" login',
    );
  });

  it("escapes shell-active characters inside $HOME-expanded double quotes", () => {
    // A path that tries to break out of the double quotes must stay inert.
    expect(m365LoginCommand('~/x";echo pwned;"').args[1]).toBe(
      'exec "$HOME/x\\";echo pwned;\\"" login',
    );
    expect(m365LoginCommand("~/x$(whoami)`id`").args[1]).toBe(
      'exec "$HOME/x\\$(whoami)\\`id\\`" login',
    );
    expect(gwsAuthCommand("$HOME/bin/g$ws").args[1]).toBe(
      'exec "$HOME/bin/g\\$ws" auth',
    );
  });
});

describe("isTelegramMonitorConfigOutsideAnchor", () => {
  it("does not warn for empty or Anchor-home monitor config paths", () => {
    expect(isTelegramMonitorConfigOutsideAnchor(null)).toBe(false);
    expect(isTelegramMonitorConfigOutsideAnchor("")).toBe(false);
    expect(isTelegramMonitorConfigOutsideAnchor(" ~/.anchor ")).toBe(false);
    expect(isTelegramMonitorConfigOutsideAnchor("~/.anchor/telegram/config.yaml")).toBe(false);
    expect(isTelegramMonitorConfigOutsideAnchor("$HOME/.anchor")).toBe(false);
    expect(isTelegramMonitorConfigOutsideAnchor("$HOME/.anchor/telegram/config.yaml")).toBe(false);
  });

  it("does not warn for absolute paths inside an Anchor home directory", () => {
    expect(
      isTelegramMonitorConfigOutsideAnchor("/Users/yj.lee/.anchor/telegram/config.yaml"),
    ).toBe(false);
    expect(isTelegramMonitorConfigOutsideAnchor("/home/foo/.anchor")).toBe(false);
  });

  it("warns for monitor config paths outside Anchor home", () => {
    expect(
      isTelegramMonitorConfigOutsideAnchor(
        "~/workspace/work/.secrets/services/telegram-monitor.config.yaml",
      ),
    ).toBe(true);
    expect(isTelegramMonitorConfigOutsideAnchor("/tmp/telegram-monitor.yaml")).toBe(true);
  });
});
