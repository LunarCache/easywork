import { describe, expect, it } from "vitest";
import { ThreadRunQueue } from "../src/agent/thread-run-queue.js";

describe("ThreadRunQueue", () => {
  it("serializes acquisitions for the same thread", async () => {
    const queue = new ThreadRunQueue();
    const first = await queue.acquire("t1");
    let secondReady = false;
    const secondPromise = queue.acquire("t1").then((release) => {
      secondReady = true;
      return release;
    });

    await Promise.resolve();
    expect(secondReady).toBe(false);

    first();
    const second = await secondPromise;
    expect(secondReady).toBe(true);
    second();
  });

  it("does not block unrelated threads", async () => {
    const queue = new ThreadRunQueue();
    const first = await queue.acquire("t1");
    const second = await queue.acquire("t2");

    second();
    first();
  });
});
