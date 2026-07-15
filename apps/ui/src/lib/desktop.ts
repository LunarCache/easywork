// 目录选择：桌面用 Tauri 命令；浏览器/无头回退为手动输入。
interface TauriWindow {
  __TAURI__?: { core?: { invoke?: <T>(cmd: string, args?: unknown) => Promise<T> } };
}

export function isDesktop(): boolean {
  return !!(window as unknown as TauriWindow).__TAURI__?.core?.invoke;
}

export function isMacOS(): boolean {
  return navigator.userAgent.includes("Macintosh");
}

/**
 * 选择本地工作区目录。
 * - 桌面（Tauri）：调用 Rust 自定义命令 select_workspace_dir 打开系统文件夹选择器。
 * - 浏览器：用 prompt 手动输入绝对路径（daemon 会校验目录存在）。
 * 返回所选绝对路径，取消则返回 null。
 */
export async function pickWorkspaceDir(): Promise<string | null> {
  const invoke = (window as unknown as TauriWindow).__TAURI__?.core?.invoke;
  if (invoke) {
    try {
      const dir = await invoke<string | null>("select_workspace_dir");
      return dir ?? null;
    } catch {
      return null;
    }
  }
  const input = window.prompt("输入本地项目目录的绝对路径：", "");
  return input && input.trim() ? input.trim() : null;
}
