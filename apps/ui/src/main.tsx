import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "highlight.js/styles/github.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
