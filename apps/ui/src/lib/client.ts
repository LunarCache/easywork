import { EasyWorkClient } from "@ew/sdk";

declare global {
  interface Window {
    ewConfig?: { baseUrl: string; token: string } | null;
    // Tauri 2 全局（withGlobalTauri）。
    __TAURI__?: { core?: { invoke<T>(cmd: string, args?: unknown): Promise<T> } };
  }
}

const LS_BASE = "ew.baseUrl";
const LS_TOKEN = "ew.token";

// Tauri 运行时下发的连接信息（最高优先级，内存态——daemon 每次随机端口，不能持久化）。
let runtime: { baseUrl: string; token: string } | undefined;

/**
 * 解析 daemon 连接信息，优先级：
 * 1) Tauri 运行时下发（runtime，桌面最高优先级）；
 * 2) URL ?baseUrl=&token=（显式启动意图，最新——并持久化到 localStorage，后续裸刷新仍连）；
 * 3) 用户在 UI 里手动设置 / 上次持久化（localStorage）；
 * 4) window.ewConfig；
 * 5) Vite env / 默认 127.0.0.1:8788。
 */
export function resolveConfig(): { baseUrl: string; token: string } {
  if (runtime) return runtime;
  // URL 参数优先且持久化：开发态用 ?baseUrl=&token= 启动一次后，裸刷新（localStorage）仍连；
  // daemon 重启换 token 时，带新 ?token= 再开即可覆盖旧值。
  const q = new URLSearchParams(location.search);
  const qBase = q.get("baseUrl");
  if (qBase) {
    const cfg = { baseUrl: qBase.replace(/\/$/, ""), token: q.get("token") ?? "" };
    localStorage.setItem(LS_BASE, cfg.baseUrl);
    localStorage.setItem(LS_TOKEN, cfg.token);
    return cfg;
  }
  const lsBase = localStorage.getItem(LS_BASE);
  if (lsBase) return { baseUrl: lsBase, token: localStorage.getItem(LS_TOKEN) ?? "" };
  if (window.ewConfig?.baseUrl && window.ewConfig.token) return window.ewConfig;
  const baseUrl = import.meta.env.VITE_EW_BASEURL ?? "http://127.0.0.1:8788";
  const token = import.meta.env.VITE_EW_TOKEN ?? "";
  return { baseUrl: baseUrl.replace(/\/$/, ""), token };
}

export function currentConfig(): { baseUrl: string; token: string } {
  return resolveConfig();
}

let cached: EasyWorkClient | undefined;

export function getClient(): EasyWorkClient {
  if (!cached) cached = new EasyWorkClient(resolveConfig());
  return cached;
}

/** UI 手动设置连接信息并重置客户端。 */
export function setConfig(baseUrl: string, token: string): void {
  localStorage.setItem(LS_BASE, baseUrl.replace(/\/$/, ""));
  localStorage.setItem(LS_TOKEN, token);
  cached = undefined;
}

/**
 * Tauri 桌面下：向 Rust 外壳取 daemon 连接信息（daemon 异步启动，带重试）。
 * 浏览器下为 no-op。
 */
export async function initRuntimeConfig(): Promise<boolean> {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return false;
  for (let i = 0; i < 30; i++) {
    try {
      const cfg = await invoke<{ baseUrl: string; token: string } | null>("get_config");
      if (cfg?.baseUrl && cfg.token) {
        runtime = { baseUrl: cfg.baseUrl.replace(/\/$/, ""), token: cfg.token };
        cached = undefined;
        return true;
      }
    } catch {
      /* 还没就绪 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
