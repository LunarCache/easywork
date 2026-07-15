import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalTheme, watchTerminalTheme, type TerminalThemeTarget } from "./terminal-theme.js";

describe("terminal theme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the app colors initially and reapplies them when the app theme changes", () => {
    const root = {} as HTMLElement;
    const host = {} as HTMLElement;
    let colors = { background: "rgb(13, 14, 18)", foreground: "rgb(231, 233, 237)", selection: "#1E212A" };
    vi.stubGlobal("document", { documentElement: root });
    vi.stubGlobal("getComputedStyle", (element: HTMLElement) => ({
      backgroundColor: element === host ? colors.background : "",
      color: element === host ? colors.foreground : "",
      getPropertyValue: (name: string) => name === "--color-bg-tertiary" ? colors.selection : "",
    }));

    let notify: MutationCallback = () => {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("MutationObserver", class {
      constructor(callback: MutationCallback) {
        notify = callback;
      }
      observe = observe;
      disconnect = disconnect;
    });

    expect(terminalTheme(host)).toEqual({
      background: colors.background,
      foreground: colors.foreground,
      cursor: colors.foreground,
      selectionBackground: colors.selection,
    });

    const target: TerminalThemeTarget = { options: {} };
    const stop = watchTerminalTheme(target, host);
    expect(observe).toHaveBeenCalledWith(root, { attributes: true, attributeFilter: ["data-theme"] });

    colors = { background: "rgb(251, 251, 252)", foreground: "rgb(21, 23, 28)", selection: "#EBEDF1" };
    notify([], {} as MutationObserver);
    expect(target.options.theme).toEqual({
      background: colors.background,
      foreground: colors.foreground,
      cursor: colors.foreground,
      selectionBackground: colors.selection,
    });

    stop();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
