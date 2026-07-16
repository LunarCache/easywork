import type { FastifyReply } from "fastify";

export interface GuardedStreamOptions {
  onCleanup?: () => void;
}

export interface GuardedStreamOpenOptions {
  status?: number;
  contentType?: string;
  origin?: string;
  heartbeat?: {
    intervalMs: number;
    chunk: string | Uint8Array;
  };
}

export interface GuardedStream {
  readonly signal: AbortSignal;
  open(options?: GuardedStreamOpenOptions): void;
  write(chunk: string | Uint8Array): boolean;
  end(finalChunk?: string | Uint8Array): void;
}

/** Owns the response socket lifecycle while protocol adapters retain frame formatting. */
export function createGuardedStream(reply: FastifyReply, options: GuardedStreamOptions = {}): GuardedStream {
  const raw = reply.raw;
  const abort = new AbortController();
  let opened = false;
  let cleaned = false;
  let ending = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const cleanup = (shouldAbort: boolean): void => {
    if (cleaned) return;
    cleaned = true;
    if (heartbeat) clearInterval(heartbeat);
    if (shouldAbort) abort.abort();
    try {
      options.onCleanup?.();
    } catch {
      // Cleanup observers cannot make a disconnected response fatal.
    }
  };
  raw.on("error", () => cleanup(true));
  raw.on("close", () => cleanup(!ending && !raw.writableEnded));

  return {
    signal: abort.signal,
    open(openOptions: GuardedStreamOpenOptions = {}): void {
      if (opened || cleaned || raw.writableEnded || raw.destroyed) return;
      opened = true;
      try {
        reply.hijack();
        raw.writeHead(openOptions.status ?? 200, {
          "content-type": openOptions.contentType ?? "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "access-control-allow-origin": openOptions.origin ?? "*",
        });
      } catch {
        cleanup(true);
        return;
      }
      const heartbeatOptions = openOptions.heartbeat;
      if (heartbeatOptions) {
        heartbeat = setInterval(() => {
          this.write(heartbeatOptions.chunk);
        }, heartbeatOptions.intervalMs);
        heartbeat.unref?.();
      }
    },
    write(chunk: string | Uint8Array): boolean {
      if (!opened || cleaned || !chunk || raw.writableEnded || raw.destroyed) return false;
      try {
        raw.write(chunk);
        return true;
      } catch {
        cleanup(true);
        return false;
      }
    },
    end(finalChunk?: string | Uint8Array): void {
      if (cleaned) return;
      if (finalChunk) this.write(finalChunk);
      if (raw.writableEnded || raw.destroyed) {
        cleanup(raw.destroyed);
        return;
      }
      ending = true;
      try {
        raw.end();
        cleanup(false);
      } catch {
        cleanup(true);
      } finally {
        ending = false;
      }
    },
  };
}
