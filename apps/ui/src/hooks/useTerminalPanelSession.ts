import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { getClient } from "../lib/client.js";
import { TerminalPanelSession } from "../lib/terminal-panel-session.js";
import type { TerminalRuntime } from "../lib/terminal-runtime.js";

interface TerminalPanelSessionOptions {
  visible: boolean;
  previewScope: "workspace" | "chat";
  previewId: string;
  runtime: TerminalRuntime;
  confirmClose(): Promise<boolean>;
}

/** React/daemon adapter for the standalone terminal panel session. */
export function useTerminalPanelSession(options: TerminalPanelSessionOptions) {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const sessionRef = useRef<TerminalPanelSession | null>(null);

  if (!sessionRef.current) {
    sessionRef.current = new TerminalPanelSession({
      list: () => {
        const { previewScope, previewId, runtime } = latest.current;
        return runtime.list(`${previewScope}:${previewId}`);
      },
      create: async () => {
        const { previewScope, previewId, runtime } = latest.current;
        const { cwd } = await getClient().terminalContext(previewScope, previewId);
        return runtime.create({ scope: `${previewScope}:${previewId}`, cwd, cols: 80, rows: 24 });
      },
      close: (sessionId, force) => latest.current.runtime.close(sessionId, force),
      confirmClose: () => latest.current.confirmClose(),
    });
  }

  const session = sessionRef.current;
  const state = useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => session.getState(),
    () => session.getState(),
  );
  const scope = `${options.previewScope}:${options.previewId}`;

  useEffect(() => {
    void session.restore();
  }, [scope, session]);

  useEffect(() => {
    if (options.visible) void session.show();
  }, [options.visible, session]);

  return {
    ...state,
    activeSession: state.sessions.find((candidate) => candidate.sessionId === state.activeSessionId) ?? state.sessions[0],
    create: () => session.create(),
    activate: (sessionId: string) => session.activate(sessionId),
    close: (sessionId: string) => session.close(sessionId),
    reportError: (error: unknown) => session.reportError(error),
  };
}
