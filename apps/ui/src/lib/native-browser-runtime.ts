export interface NativeBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeBrowserRuntime {
  readonly available: boolean;
  show(url: string, bounds: NativeBrowserBounds): Promise<void>;
  hide(): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
}

interface TauriCore {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

class UnavailableNativeBrowserRuntime implements NativeBrowserRuntime {
  readonly available = false;
  show(): Promise<void> { return Promise.resolve(); }
  hide(): Promise<void> { return Promise.resolve(); }
  reload(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { return Promise.resolve(); }
}

class TauriNativeBrowserRuntime implements NativeBrowserRuntime {
  readonly available = true;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly core: TauriCore) {}

  show(url: string, bounds: NativeBrowserBounds): Promise<void> {
    return this.enqueue("browser_surface_show", { url, bounds });
  }

  hide(): Promise<void> {
    return this.enqueue("browser_surface_hide");
  }

  reload(): Promise<void> {
    return this.enqueue("browser_surface_reload");
  }

  close(): Promise<void> {
    return this.enqueue("browser_surface_close");
  }

  private enqueue(command: string, args?: Record<string, unknown>): Promise<void> {
    const operation = this.pending.then(() => this.core.invoke<void>(command, args));
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}

let cached: NativeBrowserRuntime | null = null;

export function getNativeBrowserRuntime(): NativeBrowserRuntime {
  if (cached) return cached;
  const core = typeof window === "undefined"
    ? null
    : (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core ?? null;
  cached = core?.invoke
    ? new TauriNativeBrowserRuntime(core)
    : new UnavailableNativeBrowserRuntime();
  return cached;
}
