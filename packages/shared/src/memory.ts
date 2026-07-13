import { z } from "zod";

/**
 * 记忆分层。两类作用域用不同分层（形状不同）：
 * - 全局（= 对话记忆，所有对话共享）：user-profile / agent-memory / skills——关于「你这个人」。
 * - 工作区（每个工程独立）：conventions / decisions / pitfalls——关于「这个工程」。
 * 会话级历史由 ConversationRepo 完整存档 + FTS5（session_search 工具）承载，不在记忆层。
 */
export const GLOBAL_LAYERS = ["user-profile", "agent-memory", "skills"] as const;
export const WORKSPACE_LAYERS = ["conventions", "decisions", "pitfalls"] as const;
export const MemoryLayerSchema = z.enum([...GLOBAL_LAYERS, ...WORKSPACE_LAYERS]);
export type MemoryLayer = z.infer<typeof MemoryLayerSchema>;

/** 记忆来源：描述这条事实如何进入 EasyWork，而不是它当前是否仍依赖来源对话。 */
export const MemoryOriginSchema = z.enum([
  "manual",
  "agent-managed",
  "extracted",
  "imported",
  "provider",
]);
export type MemoryOrigin = z.infer<typeof MemoryOriginSchema>;

/** derived 仍由来源对话拥有；curated 已拥有独立生命周期。 */
export const MemoryStateSchema = z.enum(["derived", "curated"]);
export type MemoryState = z.infer<typeof MemoryStateSchema>;

/** 记忆作用域：全局（对话共享）或某工作区（隔离）。存为字符串。 */
export const GLOBAL_SCOPE = "global";
export function workspaceScope(projectId: string): string {
  return `ws:${projectId}`;
}
export function isWorkspaceScope(scope: string): boolean {
  return scope.startsWith("ws:");
}
/** 某作用域允许的分层。 */
export function layersForScope(scope: string): readonly MemoryLayer[] {
  return isWorkspaceScope(scope) ? WORKSPACE_LAYERS : GLOBAL_LAYERS;
}

/** 一个会话「能看到」的作用域+层。写入只进主作用域（visibleScopes[0]）。 */
export interface ScopeView {
  scope: string;
  layers: readonly MemoryLayer[];
}
/**
 * 某会话可见的记忆视图：
 * - 全局/对话会话：global 全部层。
 * - 工作区会话：本工作区全部层 + 全局 user-profile（你的身份/偏好,只读叠加）。
 * 第一项为「主作用域」(写入目标)。
 */
export function visibleScopes(scope: string): ScopeView[] {
  if (isWorkspaceScope(scope)) {
    return [
      { scope, layers: WORKSPACE_LAYERS },
      { scope: GLOBAL_SCOPE, layers: ["user-profile"] },
    ];
  }
  return [{ scope: GLOBAL_SCOPE, layers: GLOBAL_LAYERS }];
}

const MemoryItemBaseSchema = z.object({
  id: z.string(),
  /** 作用域：缺省 = global（对话/全局池）；工作区为 ws:<projectId>。 */
  scope: z.string().optional(),
  layer: MemoryLayerSchema,
  text: z.string(),
  origin: MemoryOriginSchema,
  state: MemoryStateSchema,
  /** Extracted Fact 的来源；提升为 Curated Fact 后清空。 */
  sourceThreadId: z.string().optional(),
  /** @deprecated sourceThreadId 的兼容别名；旧客户端迁移完成后删除。 */
  sessionId: z.string().optional(),
  score: z.number().optional(),
  updatedAt: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

function validateMemoryLifecycle(
  item: {
    origin?: MemoryOrigin;
    state?: MemoryState;
    sourceThreadId?: string;
    sessionId?: string;
  },
  ctx: z.RefinementCtx,
): void {
  const sourceThreadId = item.sourceThreadId ?? item.sessionId;
  if (item.sourceThreadId && item.sessionId && item.sourceThreadId !== item.sessionId) {
    ctx.addIssue({
      code: "custom",
      message: "sourceThreadId and sessionId must match",
      path: ["sessionId"],
    });
  }
  if (item.state === "derived") {
    if (item.origin !== undefined && item.origin !== "extracted") {
      ctx.addIssue({
        code: "custom",
        message: "derived memory must be extracted",
        path: ["origin"],
      });
    }
    if (!sourceThreadId) {
      ctx.addIssue({
        code: "custom",
        message: "derived memory requires sourceThreadId",
        path: ["sourceThreadId"],
      });
    }
  }
  if (sourceThreadId) {
    if (item.origin !== undefined && item.origin !== "extracted") {
      ctx.addIssue({
        code: "custom",
        message: "source-owned memory must be extracted",
        path: ["origin"],
      });
    }
    if (item.state === "curated") {
      ctx.addIssue({
        code: "custom",
        message: "curated memory cannot have sourceThreadId",
        path: ["state"],
      });
    }
  }
}

export const MemoryItemSchema = MemoryItemBaseSchema.superRefine(validateMemoryLifecycle);
export type MemoryItem = z.infer<typeof MemoryItemSchema>;

export const RecallQuerySchema = z.object({
  query: z.string(),
  /** 限定作用域；缺省 = global。 */
  scope: z.string().optional(),
  sessionId: z.string().optional(),
  layers: z.array(MemoryLayerSchema).optional(),
  topK: z.number().int().positive().optional(),
  minScore: z.number().optional(),
});
export type RecallQuery = z.infer<typeof RecallQuerySchema>;

export const MemoryWriteSchema = MemoryItemBaseSchema.omit({
  id: true,
  updatedAt: true,
  origin: true,
  state: true,
})
  .extend({
    origin: MemoryOriginSchema.optional(),
    state: MemoryStateSchema.optional(),
  })
  .superRefine(validateMemoryLifecycle);
export type MemoryWrite = z.infer<typeof MemoryWriteSchema>;

/**
 * 可插拔记忆提供商接口。本地默认 = 分层 markdown + sqlite-vec 语义召回；
 * 外部如 Mem0/Supermemory 实现同一接口插入。
 */
export interface MemoryProvider {
  readonly id: string;
  recall(q: RecallQuery): Promise<MemoryItem[]>;
  write(item: MemoryWrite): Promise<MemoryItem>;
  edit(id: string, patch: Partial<Pick<MemoryItem, "text" | "meta">>): Promise<MemoryItem>;
  /** 把来源事实提升为独立 Curated Fact；幂等。 */
  promote(id: string, opts?: { promotedBy?: "user" | "agent" }): Promise<MemoryItem>;
  list(filter?: { scope?: string; layer?: MemoryLayer; sessionId?: string }): Promise<MemoryItem[]>;
  delete(id: string): Promise<void>;
  /**
   * 删除某会话抽取出的记忆事实（被动抽取写入时带 sessionId）。返回删除条数。
   * 删除对话时调用——抽取的事实随来源对话一并清除；模型主动 manage_memory / 手工添加的
   * 全局事实（无 sessionId）不受影响。
   */
  deleteBySession(sessionId: string): Promise<number>;
  /** 删除某作用域的全部记忆（删除工作区时清其私有记忆池）。返回删除条数。 */
  deleteByScope(scope: string): Promise<number>;
  /**
   * 抽取钩子：抽取持久事实写入对应作用域的分层。
   * scope 缺省 = global（对话池）；工作区传 ws:<id>。model 为当轮模型 id（已加载），可复用做 LLM 抽取。
   */
  observe(input: {
    messages: unknown[];
    sessionId: string;
    scope?: string;
    model?: string;
  }): Promise<void>;
}
