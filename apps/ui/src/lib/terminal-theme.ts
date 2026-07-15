import type { ITheme } from "@xterm/xterm";

export interface TerminalThemeTarget {
  options: { theme?: ITheme };
}

export function terminalTheme(host: HTMLElement): ITheme {
  const hostStyle = getComputedStyle(host);
  const rootStyle = getComputedStyle(document.documentElement);
  return {
    background: hostStyle.backgroundColor,
    foreground: hostStyle.color,
    cursor: hostStyle.color,
    selectionBackground: rootStyle.getPropertyValue("--color-bg-tertiary").trim(),
  };
}

export function watchTerminalTheme(target: TerminalThemeTarget, host: HTMLElement): () => void {
  const observer = new MutationObserver(() => {
    target.options.theme = terminalTheme(host);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}
