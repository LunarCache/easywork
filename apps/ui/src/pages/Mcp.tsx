import { useCallback, useEffect, useState } from "react";
import type { McpServerConfig } from "@ew/shared";
import { getClient } from "../lib/client.js";
import { WrenchIcon, TrashIcon } from "../icons.js";

type Kind = "stdio" | "http";

export function Mcp() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [kind, setKind] = useState<Kind>("stdio");
  const [form, setForm] = useState({ id: "", command: "", args: "", url: "", headers: "" });
  const [note, setNote] = useState("");
  const [importText, setImportText] = useState("");
  const [probing, setProbing] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<Record<string, { ok: boolean; toolCount: number; error?: string }>>({});

  const refresh = useCallback(async () => {
    try {
      setServers(await getClient().listMcpServers());
    } catch {
      /* ignore */
    }
  }, []);

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
    setNote(`已添加 MCP 服务器 ${cfg.id}`);
    setForm({ id: "", command: "", args: "", url: "", headers: "" });
    await refresh();
  };

  const remove = async (id: string) => {
    await getClient().removeMcpServer(id);
    await refresh();
  };

  // 导入标准 mcpServers JSON（Claude/Cursor 通用格式）。
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
    await refresh();
  };

  const probe = async (cfg: McpServerConfig) => {
    setProbing(cfg.id);
    try {
      const r = await getClient().probeMcpServer(cfg);
      setProbeResult((m) => ({ ...m, [cfg.id]: r }));
    } catch (e) {
      setProbeResult((m) => ({ ...m, [cfg.id]: { ok: false, toolCount: 0, error: e instanceof Error ? e.message : String(e) } }));
    } finally {
      setProbing(null);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <span className="ico">
          <WrenchIcon size={20} />
        </span>
        <div>
          <h2>MCP 服务器</h2>
          <p className="lead">接入 Model Context Protocol 工具（stdio 本地命令 / HTTP）。工具以 mcp__&lt;server&gt;__&lt;tool&gt; 暴露给模型。</p>
        </div>
      </div>
      {note && <div className="note">{note}</div>}

      <section>
        <div className="sec-head">
          <span className="ico violet">
            <WrenchIcon size={18} />
          </span>
          <div>
            <h3>添加服务器</h3>
            <p className="hint">stdio 默认禁用，需设置环境变量 EW_ALLOW_STDIO_MCP=1 后启用。</p>
          </div>
        </div>
        <div className="seg">
          <button className={kind === "stdio" ? "on" : ""} onClick={() => setKind("stdio")}>
            stdio（本地命令）
          </button>
          <button className={kind === "http" ? "on" : ""} onClick={() => setKind("http")}>
            HTTP
          </button>
        </div>
        <div className="form" style={{ marginTop: 10 }}>
          <input placeholder="id（如 filesystem）" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
          {kind === "stdio" ? (
            <>
              <input placeholder="command（如 npx）" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
              <input placeholder="args（空格分隔）" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />
            </>
          ) : (
            <input placeholder="URL（https://…/mcp）" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
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
      </section>

      <section>
        <div className="sec-head">
          <span className="ico violet">
            <WrenchIcon size={18} />
          </span>
          <div>
            <h3>导入 mcpServers JSON</h3>
            <p className="hint">粘贴 Claude / Cursor 通用的 {`{ "mcpServers": { … } }`} 配置，批量导入。</p>
          </div>
        </div>
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
      </section>

      <section>
        <div className="sec-head">
          <span className="ico blue">
            <WrenchIcon size={18} />
          </span>
          <div>
            <h3>已配置（{servers.length}）</h3>
          </div>
        </div>
        {servers.length === 0 && (
          <div className="empty-models">
            <WrenchIcon size={26} />
            <p>还没有 MCP 服务器</p>
            <span>用上方表单添加 stdio / HTTP 服务器，或粘贴 mcpServers JSON 批量导入。</span>
          </div>
        )}
        {servers.map((s) => {
          const pr = probeResult[s.id];
          return (
            <div key={s.id} className="mcp-row">
              <div className="mcp-info">
                <div className="mcp-name">
                  {s.displayName || s.id}
                  <span className="mcp-kind">{s.transport.kind}</span>
                </div>
                <div className="mcp-detail">
                  {s.transport.kind === "stdio"
                    ? `${s.transport.command} ${s.transport.args.join(" ")}`
                    : s.transport.url}
                </div>
                {pr && (
                  <div className={`mcp-probe ${pr.ok ? "ok" : "err"}`}>
                    {pr.ok ? `✓ 连接成功 · ${pr.toolCount} 个工具` : `✗ ${pr.error ?? "连接失败"}`}
                  </div>
                )}
              </div>
              <button className="btn-ghost" style={{ padding: "5px 11px", fontSize: 12.5 }} disabled={probing === s.id} onClick={() => void probe(s)}>
                {probing === s.id ? "测试中…" : "测试"}
              </button>
              <button className="mcp-del" title="删除" onClick={() => void remove(s.id)}>
                <TrashIcon size={14} />
              </button>
            </div>
          );
        })}
      </section>
    </div>
  );
}
