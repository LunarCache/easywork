import type { TerminalSessionInfo } from "./terminal-runtime.js";

export interface TerminalPanelState {
  sessions: TerminalSessionInfo[];
  activeSessionId: string | null;
  error: string | null;
}

export interface TerminalPanelAdapters {
  list(): Promise<TerminalSessionInfo[]>;
  create(): Promise<TerminalSessionInfo>;
  close(sessionId: string, force?: boolean): Promise<"closed" | "confirmation_required">;
  confirmClose(): Promise<boolean>;
}

type Listener = () => void;

/** Owns the persistent PTY sessions shown by the standalone conversation-bottom panel. */
export class TerminalPanelSession {
  private state: TerminalPanelState = { sessions: [], activeSessionId: null, error: null };
  private readonly listeners = new Set<Listener>();
  private restorePromise: Promise<boolean> | null = null;
  private showPromise: Promise<void> | null = null;

  constructor(private readonly adapters: TerminalPanelAdapters) {}

  getState(): TerminalPanelState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  restore(): Promise<boolean> {
    if (this.restorePromise) return this.restorePromise;
    this.restorePromise = this.adapters.list()
      .then((sessions) => {
        const activeSessionId = sessions.some((session) => session.sessionId === this.state.activeSessionId)
          ? this.state.activeSessionId
          : sessions[0]?.sessionId ?? null;
        this.setState({ sessions, activeSessionId, error: null });
        return true;
      })
      .catch((error) => {
        this.reportError(error);
        return false;
      })
      .finally(() => {
        this.restorePromise = null;
      });
    return this.restorePromise;
  }

  show(): Promise<void> {
    if (this.showPromise) return this.showPromise;
    this.showPromise = this.restore()
      .then(async (restored) => {
        if (restored && this.state.sessions.length === 0) await this.create();
      })
      .finally(() => {
        this.showPromise = null;
      });
    return this.showPromise;
  }

  async create(): Promise<boolean> {
    this.setState({ error: null });
    try {
      const created = await this.adapters.create();
      const sessions = this.state.sessions.some((session) => session.sessionId === created.sessionId)
        ? this.state.sessions
        : [...this.state.sessions, created];
      this.setState({ sessions, activeSessionId: created.sessionId });
      return true;
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  activate(sessionId: string): boolean {
    if (!this.state.sessions.some((session) => session.sessionId === sessionId)) return false;
    this.setState({ activeSessionId: sessionId });
    return true;
  }

  async close(sessionId: string): Promise<boolean> {
    const index = this.state.sessions.findIndex((session) => session.sessionId === sessionId);
    if (index < 0) return false;
    try {
      const outcome = await this.adapters.close(sessionId);
      if (outcome === "confirmation_required") {
        if (!(await this.adapters.confirmClose())) return false;
        await this.adapters.close(sessionId, true);
      }
      const sessions = this.state.sessions.filter((session) => session.sessionId !== sessionId);
      const activeSessionId = this.state.activeSessionId === sessionId
        ? sessions[Math.min(index, sessions.length - 1)]?.sessionId ?? null
        : this.state.activeSessionId;
      this.setState({ sessions, activeSessionId, error: null });
      return true;
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  reportError(error: unknown): void {
    this.setState({ error: error instanceof Error ? error.message : String(error) });
  }

  private setState(patch: Partial<TerminalPanelState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
