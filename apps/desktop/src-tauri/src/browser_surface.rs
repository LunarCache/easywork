use std::sync::Mutex;

use serde::Deserialize;
use tauri::{
    webview::{NewWindowResponse, WebviewBuilder},
    LogicalPosition, LogicalSize, State, Url, Webview, WebviewUrl, Window,
};

const BROWSER_WEBVIEW_LABEL: &str = "workbench-browser";

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSurfaceBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl BrowserSurfaceBounds {
    fn validate(self) -> Result<Self, String> {
        let values = [self.x, self.y, self.width, self.height];
        if values.iter().any(|value| !value.is_finite())
            || self.x < 0.0
            || self.y < 0.0
            || self.width < 1.0
            || self.height < 1.0
        {
            return Err("浏览器区域尺寸无效".into());
        }
        Ok(self)
    }

    fn position(self) -> LogicalPosition<f64> {
        LogicalPosition::new(self.x, self.y)
    }

    fn size(self) -> LogicalSize<f64> {
        LogicalSize::new(self.width, self.height)
    }
}

#[derive(Default)]
pub struct BrowserSurfaceManager {
    current_requested_url: Mutex<Option<String>>,
}

fn parse_remote_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "浏览器地址无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("浏览器仅支持 http(s) 地址".into());
    }
    Ok(url)
}

fn browser_webview(window: &Window) -> Option<Webview> {
    window
        .webviews()
        .into_iter()
        .find(|webview| webview.label() == BROWSER_WEBVIEW_LABEL)
}

fn as_command_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[tauri::command]
pub async fn browser_surface_show(
    window: Window,
    manager: State<'_, BrowserSurfaceManager>,
    url: String,
    bounds: BrowserSurfaceBounds,
) -> Result<(), String> {
    let url = parse_remote_url(&url)?;
    let bounds = bounds.validate()?;
    let mut current_requested_url = manager.current_requested_url.lock().unwrap();

    if let Some(webview) = browser_webview(&window) {
        webview
            .set_position(bounds.position())
            .map_err(as_command_error)?;
        webview.set_size(bounds.size()).map_err(as_command_error)?;
        if current_requested_url.as_deref() != Some(url.as_str()) {
            webview.navigate(url.clone()).map_err(as_command_error)?;
        }
        webview.show().map_err(as_command_error)?;
    } else {
        let builder = WebviewBuilder::new(BROWSER_WEBVIEW_LABEL, WebviewUrl::External(url.clone()))
            .on_navigation(|url| matches!(url.scheme(), "http" | "https"))
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .disable_drag_drop_handler()
            .focused(false)
            .devtools(cfg!(debug_assertions));
        window
            .add_child(builder, bounds.position(), bounds.size())
            .map_err(as_command_error)?;
    }

    *current_requested_url = Some(url.to_string());
    Ok(())
}

#[tauri::command]
pub async fn browser_surface_hide(
    window: Window,
    manager: State<'_, BrowserSurfaceManager>,
) -> Result<(), String> {
    let _guard = manager.current_requested_url.lock().unwrap();
    if let Some(webview) = browser_webview(&window) {
        webview.hide().map_err(as_command_error)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_surface_reload(
    window: Window,
    manager: State<'_, BrowserSurfaceManager>,
) -> Result<(), String> {
    let _guard = manager.current_requested_url.lock().unwrap();
    if let Some(webview) = browser_webview(&window) {
        webview.reload().map_err(as_command_error)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_surface_close(
    window: Window,
    manager: State<'_, BrowserSurfaceManager>,
) -> Result<(), String> {
    let mut current_requested_url = manager.current_requested_url.lock().unwrap();
    if let Some(webview) = browser_webview(&window) {
        webview.close().map_err(as_command_error)?;
    }
    *current_requested_url = None;
    Ok(())
}

impl BrowserSurfaceManager {
    pub fn close(&self, window: &Window) {
        let mut current_requested_url = self.current_requested_url.lock().unwrap();
        if let Some(webview) = browser_webview(window) {
            let _ = webview.close();
        }
        *current_requested_url = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_http_urls() {
        assert_eq!(
            parse_remote_url("https://baidu.com/").unwrap().scheme(),
            "https"
        );
        assert_eq!(
            parse_remote_url("http://127.0.0.1:5173/").unwrap().scheme(),
            "http"
        );
        assert!(parse_remote_url("file:///etc/passwd").is_err());
        assert!(parse_remote_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn rejects_invalid_surface_bounds() {
        let valid = BrowserSurfaceBounds {
            x: 10.0,
            y: 20.0,
            width: 600.0,
            height: 400.0,
        };
        assert!(valid.validate().is_ok());
        assert!(BrowserSurfaceBounds {
            width: 0.0,
            ..valid
        }
        .validate()
        .is_err());
        assert!(BrowserSurfaceBounds {
            x: f64::NAN,
            ..valid
        }
        .validate()
        .is_err());
    }
}
