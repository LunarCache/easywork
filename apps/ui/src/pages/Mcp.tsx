import { useCallback, useEffect, useState } from "react";
import type { McpServerConfig } from "@ew/shared";
import { getClient } from "../lib/client.js";
import { TrashIcon, RefreshIcon, PlusIcon, ArrowLeftIcon } from "../icons.js";

type Kind = "stdio" | "http";
type Probe = { ok: boolean; toolCount: number; error?: string };

export function Mcp() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [probe, setProbe] = useState<Record<string, Probe | "busy">>({});
  const [view, setView] = useState<"list" | "add">("list");
  const [kind, setKind] = useState<Kind>("http");
  const [form, setForm] = useState({ id: "", command: "", args: "", url: "", headers: "" });
  const [importText, setImportText] = useState("");
  const [note, setNote] = useState("");

  const probeOne = useCallback(async (s: McpServerConfig) => {
    setProbe((m) => ({ ...m, [s.id]: "busy" }));
    try {
      const r = await getClient().probeMcpServer(s);
      setProbe((m) => ({ ...m, [s.id]: r }));
    } catch (e) {
      setProbe((m) => ({ ...m, [s.id]: { ok: false, toolCount: 0, error: e instanceof Error ? e.message : String(e) } }));
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await getClient().listMcpServers();
      setServers(list);
      // 自动探测每个服务器的连接状态 + 工具数（并行）。
      list.forEach((s) => void probeOne(s));
    } catch {
      /* ignore */
    }
  }, [probeOne]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const buildConfig = (): McpServerConfig | null => {
    if (!form.id.trim()) return null;
    if (kind === "stdio") {
      if (!form.command.trim()) return null;
      return {
        id: form.id.trim(),
        displayName: form.id.trim(),
        transport: { kind: "stdio", command: form.command.trim(), args: form.args.split(" ").filter(Boolean) },
        enabled: true,
      };
    }
    if (!form.url.trim()) return null;
    const headers: Record<string, string> = {};
    for (const line of form.headers.split("\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return {
      id: form.id.trim(),
      displayName: form.id.trim(),
      transport: { kind: "http", url: form.url.trim(), ...(Object.keys(headers).length ? { headers } : {}) },
      enabled: true,
    };
  };

  const add = async () => {
    const cfg = buildConfig();
    if (!cfg) return;
    await getClient().upsertMcpServer(cfg);
    setForm({ id: "", command: "", args: "", url: "", headers: "" });
    setView("list");
    await refresh();
  };

  const remove = async (id: string) => {
    await getClient().removeMcpServer(id);
    await refresh();
  };

  const toggleEnabled = async (s: McpServerConfig, e: React.MouseEvent) => {
    e.stopPropagation();
    await getClient().upsertMcpServer({ ...s, enabled: s.enabled === false });
    await refresh();
  };

  const importJson = async () => {
    let parsed: { mcpServers?: Record<string, Record<string, unknown>> };
    try {
      parsed = JSON.parse(importText) as typeof parsed;
    } catch {
      setNote("JSON 解析失败，请检查格式");
      return;
    }
    const entries = Object.entries(parsed.mcpServers ?? {});
    if (entries.length === 0) {
      setNote("未找到 mcpServers 字段");
      return;
    }
    let n = 0;
    for (const [id, raw] of entries) {
      try {
        const cfg: McpServerConfig =
          typeof raw.url === "string"
            ? {
                id,
                displayName: id,
                transport: {
                  kind: "http",
                  url: raw.url,
                  ...(raw.headers ? { headers: raw.headers as Record<string, string> } : {}),
                },
                enabled: true,
              }
            : {
                id,
                displayName: id,
                transport: {
                  kind: "stdio",
                  command: String(raw.command ?? ""),
                  args: Array.isArray(raw.args) ? (raw.args as string[]) : [],
                  ...(raw.env ? { env: raw.env as Record<string, string> } : {}),
                },
                enabled: true,
              };
        await getClient().upsertMcpServer(cfg);
        n++;
      } catch {
        /* skip bad entry */
      }
    }
    setNote(`已导入 ${n} 个 MCP 服务器`);
    setImportText("");
    setView("list");
    await refresh();
  };

  // 添加 / 导入 子视图。
  if (view === "add") {
    return (
      <div className="page mcp-page">
        <div className="skill-detail-head">
          <button className="files-back" onClick={() => setView("list")}>
            <ArrowLeftIcon size={15} /> 返回
          </button>
          <span className="skill-detail-name">添加 MCP 服务器</span>
        </div>
        {note && <div className="note">{note}</div>}

        <div className="seg" style={{ marginBottom: 10 }}>
          <button className={kind === "http" ? "on" : ""} onClick={() => setKind("http")}>
            HTTP
          </button>
          <button className={kind === "stdio" ? "on" : ""} onClick={() => setKind("stdio")}>
            stdio（本地命令）
          </button>
        </div>
        <div className="form">
          <input placeholder="id（如 filesystem）" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
          {kind === "stdio" ? (
            <>
              <input placeholder="command（如 npx）" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
              <input placeholder="args（空格分隔）" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />
            </>
          ) : (
            <input placeholder="URL（https://…/mcp 或 /sse）" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          )}
          <button onClick={() => void add()}>添加</button>
        </div>
        {kind === "http" && (
          <textarea
            placeholder="自定义请求头（每行 Key: Value，可选）"
            rows={2}
            style={{ width: "100%", marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 12.5 }}
            value={form.headers}
            onChange={(e) => setForm({ ...form, headers: e.target.value })}
          />
        )}
        <p className="hint" style={{ marginTop: 6 }}>stdio 默认禁用，需设 EW_ALLOW_STDIO_MCP=1 后启用。</p>

        <h3 style={{ fontSize: 13, margin: "22px 0 8px" }}>或粘贴 mcpServers JSON 批量导入</h3>
        <textarea
          placeholder={'{\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] },\n    "remote": { "url": "https://example.com/mcp" }\n  }\n}'}
          rows={6}
          style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 12.5 }}
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
        />
        <button className="btn" style={{ marginTop: 8 }} onClick={() => void importJson()} disabled={!importText.trim()}>
          导入
        </button>
      </div>
    );
  }

  return (
    <div className="page mcp-page">
      <div className="skills-head">
        <p className="skills-lead">接入 Model Context Protocol 工具服务器（stdio / HTTP），以 mcp__&lt;server&gt;__&lt;tool&gt; 暴露给模型。</p>
        <span className="bar-spacer" />
        <button className="set-add" onClick={() => setView("add")}>
          <PlusIcon size={14} /> 添加服务器
        </button>
      </div>
      {note && <div className="note">{note}</div>}

      {servers.length === 0 ? (
        <div className="empty-models">
          <p>还没有 MCP 服务器</p>
          <span>点右上「添加服务器」配置 stdio / HTTP，或粘贴 mcpServers JSON 批量导入。</span>
        </div>
      ) : (
        <div className="mcp-list">
          {servers.map((s) => {
            const pr = probe[s.id];
            const busy = pr === "busy";
            const res = pr && pr !== "busy" ? pr : null;
            const ok = !!res?.ok;
            const err = !!res && !res.ok;
            const on = s.enabled !== false;
            const detail =
              s.transport.kind === "stdio" ? `${s.transport.command} ${s.transport.args.join(" ")}` : s.transport.url;
            const status = busy ? "连接中…" : ok ? "已连接" : err ? "连接失败" : "未探测";
            return (
              <div key={s.id} className="mcp-card">
                <span className={`mcp-dot ${ok ? "ok" : err ? "err" : "busy"}`} />
                <div className="mcp-card-body">
                  <div className="mcp-card-name">
                    <span className="mono">{s.displayName || s.id}</span>
                    {ok && res && <span className="set-pill">{res.toolCount} 工具</span>}
                    <span className="set-pill ghost">{s.transport.kind}</span>
                  </div>
                  <div className="mcp-card-detail mono" title={detail}>
                    {detail}
                  </div>
                </div>
                <button className="mcp-icon-btn" title="重新探测" onClick={() => void probeOne(s)}>
                  <RefreshIcon size={13} className={busy ? "spin" : ""} />
                </button>
                <button className="mcp-icon-btn danger" title="删除" onClick={() => void remove(s.id)}>
                  <TrashIcon size={13} />
                </button>
                <span className={`mcp-status ${ok ? "ok" : err ? "err" : ""}`} title={err ? (res?.error ?? "") : ""}>
                  {status}
                </span>
                <button
                  className={`set-toggle ${on ? "on" : ""}`}
                  title={on ? "已启用（点击禁用）" : "已禁用（点击启用）"}
                  aria-pressed={on}
                  onClick={(e) => void toggleEnabled(s, e)}
                >
                  <span />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
