import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalRuntime, TerminalSessionInfo } from "../lib/terminal-runtime.js";
import { terminalTheme, watchTerminalTheme } from "../lib/terminal-theme.js";

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function TerminalView({
  runtime,
  session,
  onError,
}: {
  runtime: TerminalRuntime;
  session: TerminalSessionInfo;
  onError?: (message: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: terminalTheme(host),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    const reportError = (error: unknown) => {
      onErrorRef.current?.(error instanceof Error ? error.message : String(error));
    };

    const input = terminal.onData((data) => {
      void runtime.write(session.sessionId, data).catch(reportError);
    });
    let detach: (() => void) | undefined;
    let disposed = false;
    void runtime.attach(session.sessionId, (event) => {
      if (event.event === "output") {
        terminal.write(decodeBase64(event.data.data));
      } else {
        terminal.write(`\r\n\x1b[90m[进程已退出${event.data.code == null ? "" : `，code ${event.data.code}`}]\x1b[0m\r\n`);
        terminal.options.disableStdin = true;
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else detach = dispose;
    }).catch(reportError);

    const resize = () => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      fit.fit();
      void runtime.resize(session.sessionId, terminal.cols, terminal.rows).catch(reportError);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const stopWatchingTheme = watchTerminalTheme(terminal, host);
    resize();

    return () => {
      disposed = true;
      detach?.();
      observer.disconnect();
      stopWatchingTheme();
      input.dispose();
      terminal.dispose();
    };
  }, [runtime, session]);

  return <div className="terminal-view" data-testid={`terminal-view-${session.sessionId}`} ref={hostRef} />;
}
