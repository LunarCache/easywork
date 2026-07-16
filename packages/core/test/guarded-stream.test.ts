import { EventEmitter } from "node:events";
import type { FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createGuardedStream } from "../src/server/guarded-stream.js";

function replyStandIn() {
  const events = new EventEmitter();
  const raw = Object.assign(events, {
    writableEnded: false,
    destroyed: false,
    writeHead: vi.fn(),
    write: vi.fn(() => true),
    end: vi.fn(),
  });
  const reply = {
    raw,
    hijack: vi.fn(),
  } as unknown as FastifyReply;
  return { reply, raw };
}

describe("Guarded Stream", () => {
  it("aborts and cleans up once when the client disconnects, then rejects further writes", () => {
    const { reply, raw } = replyStandIn();
    const cleanup = vi.fn();
    const stream = createGuardedStream(reply, { onCleanup: cleanup });
    stream.open({ origin: "https://app.example" });

    expect(stream.write("data: ready\n\n")).toBe(true);
    raw.destroyed = true;
    raw.emit("close");
    raw.emit("close");

    expect(stream.signal.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(stream.write("data: too-late\n\n")).toBe(false);
    expect(raw.write).toHaveBeenCalledTimes(1);
  });

  it("writes a final frame and ends idempotently without reporting a client abort", () => {
    const { reply, raw } = replyStandIn();
    const cleanup = vi.fn();
    const stream = createGuardedStream(reply, { onCleanup: cleanup });
    stream.open();

    stream.end("data: [DONE]\n\n");
    stream.end("data: duplicate\n\n");

    expect(raw.write).toHaveBeenCalledWith("data: [DONE]\n\n");
    expect(raw.write).toHaveBeenCalledTimes(1);
    expect(raw.end).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(stream.signal.aborted).toBe(false);
  });

  it("owns heartbeat scheduling and stops it during cleanup", () => {
    vi.useFakeTimers();
    try {
      const { reply, raw } = replyStandIn();
      const stream = createGuardedStream(reply);
      stream.open({ heartbeat: { intervalMs: 1_000, chunk: ": keepalive\n\n" } });

      vi.advanceTimersByTime(3_000);
      expect(raw.write).toHaveBeenCalledTimes(3);
      stream.end();
      vi.advanceTimersByTime(3_000);
      expect(raw.write).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("absorbs write races and cleanup failures as a disconnected stream", () => {
    const { reply, raw } = replyStandIn();
    raw.write.mockImplementation(() => {
      throw new Error("socket closed between guard and write");
    });
    const stream = createGuardedStream(reply, {
      onCleanup: () => {
        throw new Error("observer cleanup failed");
      },
    });
    stream.open();

    expect(() => stream.write("data: raced\n\n")).not.toThrow();
    expect(stream.write("data: too-late\n\n")).toBe(false);
    expect(stream.signal.aborted).toBe(true);
  });

  it("does not open a response after the client disconnected during async preparation", () => {
    const { reply, raw } = replyStandIn();
    const stream = createGuardedStream(reply);

    raw.destroyed = true;
    raw.emit("close");
    stream.open();

    expect(reply.hijack).not.toHaveBeenCalled();
    expect(raw.writeHead).not.toHaveBeenCalled();
    expect(stream.write("data: too-late\n\n")).toBe(false);
  });

  it("absorbs a header-write race and aborts upstream work", () => {
    const { reply, raw } = replyStandIn();
    raw.writeHead.mockImplementation(() => {
      throw new Error("socket closed while opening response");
    });
    const stream = createGuardedStream(reply);

    expect(() => stream.open()).not.toThrow();
    expect(stream.signal.aborted).toBe(true);
    expect(stream.write("data: too-late\n\n")).toBe(false);
  });
});
