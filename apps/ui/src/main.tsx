import React from "react";
import { createRoot } from "react-dom/client";
// "Agent Tasks" 字体（@fontsource 内置，离线可用）：IBM Plex Sans 400/500/600/700 + JetBrains Mono 400/500/600。
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import { App } from "./App.js";
import { applyTheme, loadThemePrefs } from "./lib/prefs.js";
import "./styles.css";

// 渲染前先把持久化的明暗/强调色挂到 <html>，避免首帧主题闪烁（跟随系统按 prefers-color-scheme）。
applyTheme(loadThemePrefs());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
