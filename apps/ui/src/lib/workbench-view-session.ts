export type WorkbenchViewKind = "diff" | "files" | "browser";
export type WorkbenchOpenKind = WorkbenchViewKind;

export type WorkbenchBrowserPage =
  | { kind: "url"; url: string }
  | { kind: "html"; name: string; html: string };

export interface WorkbenchBrowserTarget {
  url: string;
  nonce: number;
}

export interface WorkbenchFileTarget {
  path: string;
  nonce: number;
}

export interface WorkbenchFileSelection {
  path: string;
  retainWhenUnlisted: boolean;
}

interface WorkbenchViewBase {
  id: string;
  label: string;
}

export type WorkbenchView =
  | (WorkbenchViewBase & { kind: "diff" })
  | (WorkbenchViewBase & { kind: "files"; selection: WorkbenchFileSelection | null })
  | (WorkbenchViewBase & { kind: "browser"; page: WorkbenchBrowserPage | null });

export interface WorkbenchViewState {
  views: WorkbenchView[];
  activeViewId: string | null;
  error: string | null;
}

export interface WorkbenchViewAdapters {
  diff: { available(): boolean; routeFileTargets(): boolean };
  files: {
    resolve(path: string): { path: string; kind: "file" | "html" };
    contains(path: string): boolean;
  };
  browser: { loadHtml(path: string): Promise<WorkbenchBrowserPage | null> };
}

export interface WorkbenchViewSessionOptions {
  defaultView(): "diff" | "files";
  adapters: WorkbenchViewAdapters;
  onEmpty(): void;
}

export type WorkbenchNavigation =
  | { kind: "browser"; url: string }
  | { kind: "file"; path: string; mode?: "external" | "browse" };

export type WorkbenchNavigationResult =
  | { status: "navigated"; destination: "browser"; url?: string }
  | { status: "navigated"; destination: "files" | "diff" }
  | { status: "rejected" };

type Listener = () => void;

const STATIC_VIEW = {
  diff: { id: "diff", kind: "diff", label: "改动" },
  files: { id: "files", kind: "files", label: "文件", selection: null },
  browser: { id: "preview", kind: "browser", label: "浏览器", page: null },
} as const satisfies Record<WorkbenchViewKind, WorkbenchView>;

/** Owns one Workbench View Session; rendering remains outside this module. */
export class WorkbenchViewSession {
  private state: WorkbenchViewState;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly options: WorkbenchViewSessionOptions) {
    const initial = this.staticView(options.defaultView());
    this.state = { views: [initial], activeViewId: initial.id, error: null };
  }

  getState(): WorkbenchViewState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  availableKinds(): WorkbenchOpenKind[] {
    return (["diff", "browser", "files"] as const).filter((kind) => {
      if (kind === "diff") return this.options.adapters.diff.available();
      return true;
    });
  }

  async open(kind: WorkbenchOpenKind): Promise<boolean> {
    if (kind === "diff" && !this.options.adapters.diff.available()) return false;
    const view = this.staticView(kind);
    const views = this.state.views.some((candidate) => candidate.id === view.id)
      ? this.state.views
      : [...this.state.views, view];
    this.setState({ views, activeViewId: view.id });
    return true;
  }

  activate(id: string): boolean {
    if (!this.state.views.some((view) => view.id === id)) return false;
    this.setState({ activeViewId: id });
    return true;
  }

  async close(id: string): Promise<boolean> {
    const index = this.state.views.findIndex((view) => view.id === id);
    if (index < 0) return false;
    const remaining = this.state.views.filter((view) => view.id !== id);
    const activeViewId =
      this.state.activeViewId === id
        ? remaining[Math.min(index, remaining.length - 1)]?.id ?? null
        : this.state.activeViewId;
    this.setState({ views: remaining, activeViewId });
    if (remaining.length === 0) this.options.onEmpty();
    return true;
  }

  async navigate(target: WorkbenchNavigation): Promise<WorkbenchNavigationResult> {
    if (target.kind === "browser") {
      const url = this.normalizeBrowserAddress(target.url);
      if (!url) return { status: "rejected" };
      this.setBrowserPage({ kind: "url", url });
      return { status: "navigated", destination: "browser", url };
    }

    const resolved = this.options.adapters.files.resolve(target.path);
    const routeToDiff = this.options.adapters.diff.routeFileTargets();
    if (resolved.kind === "html") {
      try {
        const page = await this.options.adapters.browser.loadHtml(resolved.path);
        if (page?.kind === "html") {
          this.setBrowserPage(page);
          return { status: "navigated", destination: "browser" };
        }
      } catch {
        // Fall through to Files, matching the previous preview fallback.
      }
      this.openFiles(resolved.path, target.mode !== "browse");
      return { status: "navigated", destination: "files" };
    }

    if (target.mode === "browse") {
      this.openFiles(resolved.path, false);
      return { status: "navigated", destination: "files" };
    }

    if (routeToDiff) {
      await this.open("diff");
      return { status: "navigated", destination: "diff" };
    }
    this.openFiles(resolved.path, true);
    return { status: "navigated", destination: "files" };
  }

  clearBrowser(): void {
    const views = this.state.views.map((view) =>
      view.kind === "browser" ? { ...view, page: null } : view,
    );
    this.setState({ views });
  }

  clearFileSelection(): void {
    const views = this.state.views.map((view) =>
      view.kind === "files" ? { ...view, selection: null } : view,
    );
    this.setState({ views });
  }

  reconcileFiles(): void {
    const view = this.state.views.find((candidate) => candidate.kind === "files");
    if (!view?.selection || view.selection.retainWhenUnlisted) return;
    if (!this.options.adapters.files.contains(view.selection.path)) this.clearFileSelection();
  }

  reportError(error: unknown): void {
    this.setState({ error: error instanceof Error ? error.message : String(error) });
  }

  ensureVisible(visible: boolean): void {
    if (!visible || this.state.views.length > 0) return;
    const view = this.staticView(this.options.defaultView());
    this.setState({ views: [view], activeViewId: view.id });
  }

  private staticView(kind: "diff" | "files" | "browser"): WorkbenchView {
    return { ...STATIC_VIEW[kind] };
  }

  private setBrowserPage(page: WorkbenchBrowserPage): void {
    const current = this.state.views.find((view) => view.kind === "browser");
    const view = { ...this.staticView("browser"), ...(current ?? {}), page };
    const views = current
      ? this.state.views.map((candidate) => (candidate.id === current.id ? view : candidate))
      : [...this.state.views, view];
    this.setState({ views, activeViewId: view.id });
  }

  private openFiles(path: string | null, retainWhenUnlisted = false): void {
    const current = this.state.views.find((view) => view.kind === "files");
    const view: Extract<WorkbenchView, { kind: "files" }> = {
      id: "files",
      kind: "files",
      label: "文件",
      ...(current ?? {}),
      selection: path ? { path, retainWhenUnlisted } : null,
    };
    const views = current
      ? this.state.views.map((candidate) => (candidate.id === current.id ? view : candidate))
      : [...this.state.views, view];
    this.setState({ views, activeViewId: view.id });
  }

  private normalizeBrowserAddress(value: string): string | null {
    const input = value.trim();
    if (!input) return null;
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`;
    try {
      const parsed = new URL(candidate);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
    } catch {
      return null;
    }
  }

  private setState(patch: Partial<WorkbenchViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
