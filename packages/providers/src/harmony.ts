/**
 * gpt-oss harmony 多通道流式解析（兜底）。
 *
 * 部分 llama.cpp / 原始输出会把 harmony 控制 token 直接放进 content：
 *   <|channel|>analysis<|message|>思考…<|end|><|start|>assistant<|channel|>final<|message|>正文<|return|>
 * 较新的 llama.cpp 会自行解析并以 delta.reasoning_content 给出 analysis（已在引擎层映射）。
 * 本解析器处理"未解析、原始 token 落到 content"的兜底情形：
 *   - analysis / commentary 通道 → reasoning
 *   - final 通道（或出现任何 channel 标记前的普通文本）→ text
 * 并剥离所有 <|...|> 控制 token。流式安全：尾部可能是半个标记时缓冲等待。
 */

const CONTROL_TOKENS = ["<|start|>", "<|channel|>", "<|message|>", "<|end|>", "<|return|>", "<|constrain|>"];

export interface HarmonySegment {
  reasoning?: string;
  text?: string;
}

export class HarmonyParser {
  /** 当前通道：未见到任何 channel 标记前按 text 透传。 */
  private channel: "text" | "analysis" | "final" | "commentary" = "text";
  /** 是否进入"读取 channel 名"状态（<|channel|> 与 <|message|> 之间）。 */
  private readingChannel = false;
  /** 消息头区域（<|start|> 之后到 <|message|> 之前）：role 等头部文本应忽略。 */
  private inHeader = false;
  private channelName = "";
  private buf = "";
  private sawMarker = false;

  /** 是否检测到 harmony 标记（用于判断该流是否走 harmony 语义）。 */
  get isHarmony(): boolean {
    return this.sawMarker;
  }

  /** 尾部可能是某个控制 token 的前缀 → 需要缓冲等待后续 chunk。 */
  private maybePartialTail(s: string): number {
    const lt = s.lastIndexOf("<");
    if (lt < 0) return -1;
    const tail = s.slice(lt);
    if (tail.includes(">")) return -1; // 已闭合，不是半个
    // tail 是否为某控制 token 的前缀（或通用 "<|" 前缀）
    if ("<|".startsWith(tail) || tail.startsWith("<|")) {
      if (CONTROL_TOKENS.some((t) => t.startsWith(tail)) || tail === "<" || tail === "<|") return lt;
      // 形如 "<|chan" 也算（控制 token 名未写全）
      if (/^<\|[a-z]*$/.test(tail)) return lt;
    }
    return -1;
  }

  push(chunk: string): HarmonySegment {
    this.buf += chunk;
    let reasoning = "";
    let text = "";

    // 先扣下尾部可能的半个标记，剩余部分解析。
    const cut = this.maybePartialTail(this.buf);
    const work = cut >= 0 ? this.buf.slice(0, cut) : this.buf;
    const held = cut >= 0 ? this.buf.slice(cut) : "";
    this.buf = held;

    let rest = work;
    while (rest.length > 0) {
      // 找到下一个 "<|"
      const idx = rest.indexOf("<|");
      const plain = idx < 0 ? rest : rest.slice(0, idx);
      if (plain) {
        if (this.readingChannel) {
          this.channelName += plain;
        } else if (this.inHeader) {
          /* 消息头（role 等）→ 忽略 */
        } else if (this.channel === "analysis" || this.channel === "commentary") {
          reasoning += plain;
        } else {
          text += plain; // text / final
        }
      }
      if (idx < 0) break;
      rest = rest.slice(idx);
      // 取出控制 token
      const end = rest.indexOf("|>");
      if (end < 0) {
        // 不应发生（半个已被缓冲），保险起见停止
        this.buf = rest + this.buf;
        break;
      }
      const token = rest.slice(0, end + 2);
      rest = rest.slice(end + 2);
      this.sawMarker = true;
      if (token === "<|channel|>") {
        this.readingChannel = true;
        this.channelName = "";
      } else if (token === "<|message|>") {
        this.readingChannel = false;
        this.inHeader = false;
        const name = this.channelName.trim();
        this.channel =
          name === "analysis" ? "analysis" : name === "commentary" ? "commentary" : "final";
      } else if (token === "<|start|>") {
        // 新消息头开始：忽略 role 等头部文本，直到 <|message|>。
        this.inHeader = true;
        this.readingChannel = false;
      } else if (token === "<|end|>" || token === "<|return|>") {
        // 段落结束：回到等待下一段（默认 text，避免残留文本误入 reasoning）。
        this.readingChannel = false;
        this.channel = "final";
      }
      // <|constrain|> 等其它控制 token：忽略
    }

    return { ...(reasoning ? { reasoning } : {}), ...(text ? { text } : {}) };
  }

  /** 流结束：吐出残留缓冲（按当前通道归类，剥离任何残留控制 token）。 */
  flush(): HarmonySegment {
    const leftover = this.buf;
    this.buf = "";
    if (!leftover) return {};
    const cleaned = leftover.replace(/<\|[^|]*\|?>?/g, "");
    if (!cleaned) return {};
    if (this.channel === "analysis" || this.channel === "commentary") return { reasoning: cleaned };
    return { text: cleaned };
  }
}
