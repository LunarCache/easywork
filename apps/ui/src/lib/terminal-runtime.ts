export interface TerminalSessionInfo {
  sessionId: string;
  scope: string;
  title: string;
  cwd: string;
}

export type TerminalEvent =
  | { event: "output"; data: { data: string } }
  | { event: "exit"; data: { code: number | null } };

export interface TerminalRuntime {
  readonly available: boolean;
  list(scope: string): Promise<TerminalSessionInfo[]>;
  create(input: { scope: string; cwd: string; cols: number; rows: number }): Promise<TerminalSessionInfo>;
  attach(sessionId: string, onEvent: (event: TerminalEvent) => void): Promise<() => void>;
  write(sessionId: string, data: string): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  close(sessionId: string, force?: boolean): Promise<"closed" | "confirmation_required">;
}

interface TauriChannel<T> {
  onmessage?: (event: T) => void;
}

interface TauriCore {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  Channel?: new <T>() => TauriChannel<T>;
}

function tauriCore(): TauriCore | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core ?? null;
}

class UnavailableTerminalRuntime implements TerminalRuntime {
  readonly available = false;
  private fail(): never {
    throw new Error("真终端仅在 EasyWork Desktop 中可用");
  }
  list(): Promise<TerminalSessionInfo[]> { return Promise.resolve([]); }
  async create(): Promise<TerminalSessionInfo> { return this.fail(); }
  async attach(): Promise<() => void> { return this.fail(); }
  async write(): Promise<void> { return this.fail(); }
  async resize(): Promise<void> { return this.fail(); }
  async close(): Promise<"closed" | "confirmation_required"> { return this.fail(); }
}

class TauriTerminalRuntime implements TerminalRuntime {
  readonly available = true;

  constructor(private readonly core: TauriCore & { Channel: new <T>() => TauriChannel<T> }) {}

  list(scope: string): Promise<TerminalSessionInfo[]> {
    return this.core.invoke("terminal_list", { scope });
  }

  create(input: { scope: string; cwd: string; cols: number; rows: number }): Promise<TerminalSessionInfo> {
    return this.core.invoke("terminal_create", input);
  }

  async attach(sessionId: string, onEvent: (event: TerminalEvent) => void): Promise<() => void> {
    const channel = new this.core.Channel<TerminalEvent>();
    channel.onmessage = onEvent;
    const attachmentId = await this.core.invoke<string>("terminal_attach", { sessionId, channel });
    return () => {
      void this.core.invoke("terminal_detach", { sessionId, attachmentId }).catch(() => undefined);
    };
  }

  write(sessionId: string, data: string): Promise<void> {
    return this.core.invoke("terminal_write", { sessionId, data });
  }

  resize(sessionId: string, cols: number, rows: number): Promise<void> {
    return this.core.invoke("terminal_resize", { sessionId, cols, rows });
  }

  close(sessionId: string, force = false): Promise<"closed" | "confirmation_required"> {
    return this.core.invoke("terminal_close", { sessionId, force });
  }
}

let cached: TerminalRuntime | null = null;

export function getTerminalRuntime(): TerminalRuntime {
  if (cached) return cached;
  const core = tauriCore();
  cached = core?.invoke && core.Channel
    ? new TauriTerminalRuntime(core as TauriCore & { Channel: new <T>() => TauriChannel<T> })
    : new UnavailableTerminalRuntime();
  return cached;
}
