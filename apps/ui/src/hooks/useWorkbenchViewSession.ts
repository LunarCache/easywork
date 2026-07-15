import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { WsEntry } from "@ew/sdk";
import { getClient } from "../lib/client.js";
import { matchFileTarget } from "../lib/file-target.js";
import { resolvePreviewKind } from "../lib/preview.js";
import type { NativeBrowserRuntime } from "../lib/native-browser-runtime.js";
import {
  WorkbenchViewSession,
  type WorkbenchBrowserTarget,
  type WorkbenchFileTarget,
  type WorkbenchNavigationResult,
  type WorkbenchOpenKind,
} from "../lib/workbench-view-session.js";

interface WorkbenchViewSessionOptions {
  files: WsEntry[];
  previewScope: "workspace" | "chat";
  previewId: string;
  browserTarget: WorkbenchBrowserTarget | null;
  fileTarget?: WorkbenchFileTarget | null;
  hasDiff: boolean;
  routeFileTargetsToDiff: boolean;
  nativeBrowserRuntime: NativeBrowserRuntime;
}

/** React/daemon adapter for the framework-independent Workbench View Session module. */
export function useWorkbenchViewSession(options: WorkbenchViewSessionOptions) {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const sessionRef = useRef<WorkbenchViewSession | null>(null);

  if (!sessionRef.current) {
    sessionRef.current = new WorkbenchViewSession({
      diff: {
        available: () => latest.current.hasDiff,
        routeFileTargets: () => latest.current.routeFileTargetsToDiff,
      },
      files: {
        resolve: (path) => {
          const resolved = matchFileTarget(latest.current.files, path)?.path ?? path;
          return { path: resolved, kind: resolvePreviewKind(resolved) === "html" ? "html" : "file" };
        },
        contains: (path) => latest.current.files.some((file) => file.path === path),
      },
      browser: {
        loadHtml: async (path) => {
          const { previewScope, previewId } = latest.current;
          const meta = await getClient().previewMeta(previewScope, previewId, path);
          return meta.kind === "html"
            ? { kind: "html", name: meta.name, html: meta.text ?? "" }
            : null;
        },
        closeSurface: () => latest.current.nativeBrowserRuntime.close(),
      },
    });
  }

  const session = sessionRef.current;
  const state = useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => session.getState(),
    () => session.getState(),
  );

  useEffect(() => session.reconcileFiles(), [options.files, session]);

  useEffect(() => () => {
    void session.dispose();
  }, [session]);

  useEffect(() => {
    if (options.browserTarget) {
      void session.navigate({ kind: "browser", url: options.browserTarget.url });
    }
  }, [options.browserTarget?.nonce, session]);

  useEffect(() => {
    if (options.fileTarget) {
      void session.navigate({ kind: "file", path: options.fileTarget.path });
    }
  }, [options.fileTarget?.nonce, session]);

  const activeView = state.views.find((view) => view.id === state.activeViewId) ?? state.views[0];
  return {
    ...state,
    activeView,
    availableKinds: session.availableKinds(),
    open: (kind: WorkbenchOpenKind) => session.open(kind),
    activate: (id: string) => session.activate(id),
    close: (id: string) => session.close(id),
    navigateBrowser: (url: string): Promise<WorkbenchNavigationResult> => session.navigate({ kind: "browser", url }),
    openFile: (path: string): Promise<WorkbenchNavigationResult> =>
      session.navigate({ kind: "file", path, mode: "browse" }),
    clearFileSelection: () => session.clearFileSelection(),
    clearBrowser: () => session.clearBrowser(),
    reportError: (error: unknown) => session.reportError(error),
  };
}
