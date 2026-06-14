/**
 * 解析上游 OpenAI 兼容的 SSE 流：把 ReadableStream 拆成一个个 `data:` JSON 帧，
 * 遇到 `[DONE]` 结束。容忍跨 chunk 的半行。
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const raw of frame.split("\n")) {
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          if (!data) continue;
          try {
            yield JSON.parse(data) as Record<string, unknown>;
          } catch {
            // 忽略坏帧
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
