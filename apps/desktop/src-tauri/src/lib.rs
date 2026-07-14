// EasyWork 桌面外壳（Tauri 2）：启动 Node core daemon 子进程，解析其 stdout 首行
// {baseUrl, token} 连接信息并暴露给 webview；退出时回收 daemon。
//
// macOS / Windows 共用同一壳层；平台差异只留在资源内的 SEA 文件名与系统目录解析。

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use serde::Serialize;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

mod terminal;
use terminal::TerminalSessionManager;

#[derive(Clone, Serialize)]
struct DaemonInfo {
    #[serde(rename = "baseUrl")]
    base_url: String,
    token: String,
}

#[derive(Default)]
struct AppState {
    info: Mutex<Option<DaemonInfo>>,
    child: Mutex<Option<Child>>,
}

/// webview 通过 invoke('get_config') 取连接信息。
#[tauri::command]
fn get_config(state: State<'_, AppState>) -> Option<DaemonInfo> {
    state.info.lock().unwrap().clone()
}

/// 打开系统文件夹选择对话框，返回所选目录绝对路径（取消则 None）。工作区模式用。
/// 用非阻塞 pick_folder（rfd 内部派发到主线程）+ 通道异步取回，避免在主线程 block 导致卡死。
#[tauri::command]
async fn select_workspace_dir(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |f| {
        let _ = tx.send(f);
    });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .ok()
        .flatten();
    picked
        .and_then(|p| p.into_path().ok())
        .map(|pb| pb.to_string_lossy().to_string())
}

fn data_dir() -> String {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    format!("{home}/.easywork")
}

/// 构造启动 core daemon 的命令。
/// - 打包：随附的单文件二进制 `daemon/easywork[.exe] serve`（Node SEA，免 Node；vec0 动态库同目录自动解析）。
/// - 开发：`node $EW_DAEMON_ENTRY serve`（由 npm 脚本设为 cli.js 绝对路径）。
fn build_daemon_command(app: &tauri::AppHandle) -> Command {
    let exe_name = if cfg!(windows) {
        "easywork.exe"
    } else {
        "easywork"
    };
    if std::env::var("EW_DAEMON_ENTRY").is_err() {
        if let Ok(dir) = app.path().resource_dir() {
            let bin = dir.join("daemon").join(exe_name);
            if bin.exists() {
                let mut cmd = Command::new(bin);
                cmd.args(["serve", "--port", "0"]);
                return cmd;
            }
        }
    }
    // 开发：用 node 跑 cli.js（EW_DAEMON_ENTRY 绝对路径，或相对兜底）。
    let entry =
        std::env::var("EW_DAEMON_ENTRY").unwrap_or_else(|_| "../../daemon/dist/cli.js".into());
    let mut cmd = Command::new("node");
    cmd.arg(entry).args(["serve", "--port", "0"]);
    cmd
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(TerminalSessionManager::default())
        .invoke_handler(tauri::generate_handler![
            get_config,
            select_workspace_dir,
            terminal::terminal_list,
            terminal::terminal_create,
            terminal::terminal_attach,
            terminal::terminal_detach,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let mut child = build_daemon_command(&handle)
                .env("EW_DATA_DIR", data_dir())
                .stdout(Stdio::piped())
                .spawn()
                .expect("无法启动 core daemon");

            let stdout = child.stdout.take().expect("daemon 无 stdout");
            let reader_handle = handle.clone();
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    let t = line.trim();
                    if !t.starts_with('{') {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
                        if let (Some(b), Some(tok)) = (
                            v.get("baseUrl").and_then(|x| x.as_str()),
                            v.get("token").and_then(|x| x.as_str()),
                        ) {
                            let st = reader_handle.state::<AppState>();
                            *st.info.lock().unwrap() = Some(DaemonInfo {
                                base_url: b.to_string(),
                                token: tok.to_string(),
                            });
                            break;
                        }
                    }
                }
            });

            app.state::<AppState>().child.lock().unwrap().replace(child);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 初始化失败")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                app_handle.state::<TerminalSessionManager>().close_all();
                // 退出时回收 daemon 子进程。
                if let Some(mut child) = app_handle.state::<AppState>().child.lock().unwrap().take()
                {
                    let _ = child.kill();
                }
            }
        });
}
