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
 * 1) 用户在 UI 里手动设置（localStorage）；
 * 2) Electron preload 注入的 window.ewConfig；
 * 3) 浏览器：URL ?baseUrl=&token= 或 Vite env；
 * 4) 默认 127.0.0.1:8788。
 */
export function resolveConfig(): { baseUrl: string; token: string } {
  if (runtime) return runtime;
  const lsBase = localStorage.getItem(LS_BASE);
  const lsToken = localStorage.getItem(LS_TOKEN);
  if (lsBase) return { baseUrl: lsBase, token: lsToken ?? "" };
  if (window.ewConfig?.baseUrl && window.ewConfig.token) return window.ewConfig;
  const q = new URLSearchParams(location.search);
  const baseUrl = q.get("baseUrl") ?? import.meta.env.VITE_EW_BASEURL ?? "http://127.0.0.1:8788";
  const token = q.get("token") ?? import.meta.env.VITE_EW_TOKEN ?? "";
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
