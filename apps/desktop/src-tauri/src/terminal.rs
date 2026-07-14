use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
#[cfg(any(windows, test))]
use sysinfo::{Pid, System};
use tauri::ipc::Channel;
use tauri::State;

const OUTPUT_CAP: usize = 2 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    session_id: String,
    scope: String,
    title: String,
    cwd: String,
}

#[derive(Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "event",
    content = "data"
)]
pub enum TerminalEvent {
    Output { data: String },
    Exit { code: Option<u32> },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalCloseOutcome {
    Closed,
    ConfirmationRequired,
}

#[derive(Default)]
struct TerminalStreamState {
    output: Mutex<Vec<u8>>,
    subscribers: Mutex<HashMap<u64, Channel<TerminalEvent>>>,
    exit_code: Mutex<Option<Option<u32>>>,
}

struct TerminalSession {
    info: TerminalSessionInfo,
    order: u64,
    title_index: usize,
    shell_pid: Option<u32>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    stream: Arc<TerminalStreamState>,
}

#[derive(Default)]
pub struct TerminalSessionManager {
    sessions: Mutex<HashMap<String, Arc<TerminalSession>>>,
    next_session: AtomicU64,
    next_attachment: AtomicU64,
}

fn lock_error(label: &str) -> String {
    format!("{label} lock poisoned")
}

#[cfg(any(windows, test))]
fn has_descendant_process(root_pid: u32) -> bool {
    let system = System::new_all();
    let root = Pid::from_u32(root_pid);
    system.processes().keys().any(|candidate| {
        if *candidate == root {
            return false;
        }
        let mut current = *candidate;
        for _ in 0..128 {
            let Some(parent) = system.process(current).and_then(|process| process.parent()) else {
                return false;
            };
            if parent == root {
                return true;
            }
            if parent == current {
                return false;
            }
            current = parent;
        }
        false
    })
}

fn broadcast_output(stream: &TerminalStreamState, bytes: &[u8]) {
    let encoded = BASE64.encode(bytes);
    if let Ok(mut output) = stream.output.lock() {
        output.extend_from_slice(bytes);
        if output.len() > OUTPUT_CAP {
            let overflow = output.len() - OUTPUT_CAP;
            output.drain(..overflow);
        }
    }
    if let Ok(mut subscribers) = stream.subscribers.lock() {
        subscribers.retain(|_, channel| {
            channel
                .send(TerminalEvent::Output {
                    data: encoded.clone(),
                })
                .is_ok()
        });
    }
}

fn broadcast_exit(stream: &TerminalStreamState, code: Option<u32>) {
    if let Ok(mut exit_code) = stream.exit_code.lock() {
        *exit_code = Some(code);
    }
    if let Ok(mut subscribers) = stream.subscribers.lock() {
        subscribers.retain(|_, channel| channel.send(TerminalEvent::Exit { code }).is_ok());
    }
}

impl TerminalSessionManager {
    fn list(&self, scope: &str) -> Result<Vec<TerminalSessionInfo>, String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| lock_error("terminal sessions"))?;
        let mut matching = sessions
            .values()
            .filter(|session| session.info.scope == scope)
            .map(|session| (session.order, session.info.clone()))
            .collect::<Vec<_>>();
        matching.sort_by_key(|(order, _)| *order);
        Ok(matching.into_iter().map(|(_, info)| info).collect())
    }

    fn create(
        &self,
        scope: String,
        cwd: String,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalSessionInfo, String> {
        if !Path::new(&cwd).is_dir() {
            return Err(format!("终端工作目录不存在：{cwd}"));
        }
        let order = self.next_session.fetch_add(1, Ordering::Relaxed) + 1;
        let title_index = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|_| lock_error("terminal sessions"))?;
            sessions
                .values()
                .filter(|session| session.info.scope == scope)
                .map(|session| session.title_index)
                .max()
                .unwrap_or(0)
                + 1
        };
        let session_id = format!("term-{order}");
        let title = format!("终端 {title_index}");

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("创建 PTY 失败：{error}"))?;
        let mut command = CommandBuilder::new_default_prog();
        command.cwd(&cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("启动 shell 失败：{error}"))?;
        let shell_pid = child.process_id();
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("连接 PTY 输出失败：{error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("连接 PTY 输入失败：{error}"))?;
        let killer = child.clone_killer();
        let stream = Arc::new(TerminalStreamState::default());
        let info = TerminalSessionInfo {
            session_id: session_id.clone(),
            scope,
            title,
            cwd,
        };
        let session = Arc::new(TerminalSession {
            info: info.clone(),
            order,
            title_index,
            shell_pid,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            stream: stream.clone(),
        });
        self.sessions
            .lock()
            .map_err(|_| lock_error("terminal sessions"))?
            .insert(session_id, session);

        let output_stream = stream.clone();
        thread::spawn(move || {
            let mut reader = reader;
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => broadcast_output(&output_stream, &buffer[..read]),
                }
            }
        });
        thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            broadcast_exit(&stream, code);
        });

        Ok(info)
    }

    fn session(&self, session_id: &str) -> Result<Arc<TerminalSession>, String> {
        self.sessions
            .lock()
            .map_err(|_| lock_error("terminal sessions"))?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "终端会话不存在".to_string())
    }

    fn attach(&self, session_id: &str, channel: Channel<TerminalEvent>) -> Result<u64, String> {
        let session = self.session(session_id)?;
        let attachment_id = self.next_attachment.fetch_add(1, Ordering::Relaxed) + 1;
        let output = session
            .stream
            .output
            .lock()
            .map_err(|_| lock_error("terminal output"))?;
        if !output.is_empty() {
            channel
                .send(TerminalEvent::Output {
                    data: BASE64.encode(output.as_slice()),
                })
                .map_err(|error| format!("发送终端快照失败：{error}"))?;
        }
        let exit_code = *session
            .stream
            .exit_code
            .lock()
            .map_err(|_| lock_error("terminal exit"))?;
        session
            .stream
            .subscribers
            .lock()
            .map_err(|_| lock_error("terminal subscribers"))?
            .insert(attachment_id, channel.clone());
        drop(output);
        if let Some(code) = exit_code {
            channel
                .send(TerminalEvent::Exit { code })
                .map_err(|error| format!("发送终端退出状态失败：{error}"))?;
        }
        Ok(attachment_id)
    }

    fn detach(&self, session_id: &str, attachment_id: u64) -> Result<(), String> {
        let session = self.session(session_id)?;
        session
            .stream
            .subscribers
            .lock()
            .map_err(|_| lock_error("terminal subscribers"))?
            .remove(&attachment_id);
        Ok(())
    }

    fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let session = self.session(session_id)?;
        let mut writer = session
            .writer
            .lock()
            .map_err(|_| lock_error("terminal writer"))?;
        writer
            .write_all(data.as_bytes())
            .map_err(|error| format!("写入终端失败：{error}"))?;
        writer
            .flush()
            .map_err(|error| format!("刷新终端输入失败：{error}"))
    }

    fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.session(session_id)?;
        let result = session
            .master
            .lock()
            .map_err(|_| lock_error("terminal pty"))?
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("调整终端尺寸失败：{error}"));
        result
    }

    fn has_foreground_process(session: &TerminalSession) -> bool {
        let exited = session
            .stream
            .exit_code
            .lock()
            .map(|exit_code| exit_code.is_some())
            .unwrap_or(true);
        if exited {
            return false;
        }

        #[cfg(unix)]
        {
            let Ok(master) = session.master.lock() else {
                return true;
            };
            let shell_group = session.shell_pid.and_then(|pid| {
                let group = unsafe { libc::getpgid(pid as libc::pid_t) };
                (group > 0).then_some(group)
            });
            if let (Some(fd), Some(shell_group)) = (master.as_raw_fd(), shell_group) {
                let foreground_group = unsafe { libc::tcgetpgrp(fd) };
                return foreground_group > 0 && foreground_group != shell_group;
            }
            false
        }
        #[cfg(windows)]
        {
            // ConPTY 不暴露 Unix 式 foreground process group；空闲 shell 无后代，
            // 有仍存活的子孙进程时才视为前台任务并要求确认。
            session
                .shell_pid
                .map(has_descendant_process)
                .unwrap_or(false)
        }
    }

    fn close(&self, session_id: &str, force: bool) -> Result<TerminalCloseOutcome, String> {
        let session = self.session(session_id)?;
        if !force && Self::has_foreground_process(&session) {
            return Ok(TerminalCloseOutcome::ConfirmationRequired);
        }
        let exited = session
            .stream
            .exit_code
            .lock()
            .map_err(|_| lock_error("terminal exit"))?
            .is_some();
        if !exited {
            session
                .killer
                .lock()
                .map_err(|_| lock_error("terminal process"))?
                .kill()
                .map_err(|error| format!("结束终端失败：{error}"))?;
        }
        self.sessions
            .lock()
            .map_err(|_| lock_error("terminal sessions"))?
            .remove(session_id);
        Ok(TerminalCloseOutcome::Closed)
    }

    pub fn close_all(&self) {
        let sessions = self
            .sessions
            .lock()
            .map(|mut sessions| sessions.drain().map(|(_, value)| value).collect::<Vec<_>>());
        if let Ok(sessions) = sessions {
            for session in sessions {
                if let Ok(mut killer) = session.killer.lock() {
                    let _ = killer.kill();
                }
            }
        }
    }
}

#[tauri::command]
pub fn terminal_list(
    scope: String,
    manager: State<'_, TerminalSessionManager>,
) -> Result<Vec<TerminalSessionInfo>, String> {
    manager.list(&scope)
}

#[tauri::command]
pub fn terminal_create(
    scope: String,
    cwd: String,
    cols: u16,
    rows: u16,
    manager: State<'_, TerminalSessionManager>,
) -> Result<TerminalSessionInfo, String> {
    manager.create(scope, cwd, cols, rows)
}

#[tauri::command]
pub fn terminal_attach(
    session_id: String,
    channel: Channel<TerminalEvent>,
    manager: State<'_, TerminalSessionManager>,
) -> Result<u64, String> {
    manager.attach(&session_id, channel)
}

#[tauri::command]
pub fn terminal_detach(
    session_id: String,
    attachment_id: u64,
    manager: State<'_, TerminalSessionManager>,
) -> Result<(), String> {
    manager.detach(&session_id, attachment_id)
}

#[tauri::command]
pub fn terminal_write(
    session_id: String,
    data: String,
    manager: State<'_, TerminalSessionManager>,
) -> Result<(), String> {
    manager.write(&session_id, &data)
}

#[tauri::command]
pub fn terminal_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    manager: State<'_, TerminalSessionManager>,
) -> Result<(), String> {
    manager.resize(&session_id, cols, rows)
}

#[tauri::command]
pub fn terminal_close(
    session_id: String,
    force: bool,
    manager: State<'_, TerminalSessionManager>,
) -> Result<TerminalCloseOutcome, String> {
    manager.close(&session_id, force)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[cfg(unix)]
    #[test]
    fn descendant_detection_distinguishes_idle_processes_from_active_children() {
        let mut shell = std::process::Command::new("sh")
            .args(["-c", "sleep 5 & wait"])
            .spawn()
            .expect("spawn shell with child");
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut detected = false;
        while Instant::now() < deadline {
            if has_descendant_process(shell.id()) {
                detected = true;
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let _ = shell.kill();
        let _ = shell.wait();
        assert!(detected, "child process was not detected");
        assert!(!has_descendant_process(u32::MAX));
    }

    #[test]
    fn real_pty_accepts_input_and_keeps_terminal_titles_unique() {
        let manager = TerminalSessionManager::default();
        let cwd = std::env::current_dir().expect("current dir");
        let scope = "workspace:test".to_string();
        let first = manager
            .create(scope.clone(), cwd.to_string_lossy().into_owned(), 80, 24)
            .expect("create first terminal");
        let second = manager
            .create(scope.clone(), cwd.to_string_lossy().into_owned(), 100, 30)
            .expect("create second terminal");
        assert_eq!(first.title, "终端 1");
        assert_eq!(second.title, "终端 2");
        assert_eq!(manager.list(&scope).expect("list terminals").len(), 2);

        #[cfg(unix)]
        let command = "printf 'EW_PTY_OK\\n'\r";
        #[cfg(windows)]
        let command = "echo EW_PTY_OK\r";
        manager
            .write(&second.session_id, command)
            .expect("write command");

        let session = manager
            .session(&second.session_id)
            .expect("terminal session");
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut captured = String::new();
        while Instant::now() < deadline {
            captured =
                String::from_utf8_lossy(&session.stream.output.lock().expect("terminal output"))
                    .into_owned();
            if captured.contains("EW_PTY_OK") {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(captured.contains("EW_PTY_OK"), "PTY output: {captured:?}");

        assert_eq!(
            manager
                .close(&first.session_id, false)
                .expect("close idle shell"),
            TerminalCloseOutcome::Closed,
        );
        let third = manager
            .create(scope.clone(), cwd.to_string_lossy().into_owned(), 80, 24)
            .expect("create third terminal");
        assert_eq!(third.title, "终端 3");
        manager.close_all();
    }

    #[cfg(unix)]
    #[test]
    fn active_foreground_process_requires_close_confirmation() {
        let manager = TerminalSessionManager::default();
        let cwd = std::env::current_dir().expect("current dir");
        let session_info = manager
            .create(
                "workspace:foreground".to_string(),
                cwd.to_string_lossy().into_owned(),
                80,
                24,
            )
            .expect("create terminal");

        // The marker is encoded so the PTY input echo cannot satisfy the wait;
        // seeing it proves the foreground child has started executing.
        manager
            .write(
                &session_info.session_id,
                concat!(
                    r#"sh -c 'printf "\105\127\137\106\117\122\105\107\122\117\125\116\104\137\122\105\101\104\131\n"; sleep 30'"#,
                    "\r"
                ),
            )
            .expect("start foreground task");

        let session = manager
            .session(&session_info.session_id)
            .expect("terminal session");
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut captured = String::new();
        while Instant::now() < deadline {
            captured =
                String::from_utf8_lossy(&session.stream.output.lock().expect("terminal output"))
                    .into_owned();
            if captured.contains("EW_FOREGROUND_READY") {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            captured.contains("EW_FOREGROUND_READY"),
            "foreground task did not start; PTY output: {captured:?}"
        );

        let outcome = manager
            .close(&session_info.session_id, false)
            .expect("request terminal close");
        if outcome == TerminalCloseOutcome::ConfirmationRequired {
            manager
                .close(&session_info.session_id, true)
                .expect("force close terminal after confirmation check");
        }
        assert_eq!(outcome, TerminalCloseOutcome::ConfirmationRequired);
    }
}
