import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./themes.css";
import "@xterm/xterm/css/xterm.css";

/**
 * Stamp the theme before React mounts.
 *
 * Read from localStorage rather than waited for from the server: the settings
 * request takes a round trip, and painting the default palette first makes
 * every page load flash.
 */
const saved = localStorage.getItem("tnui:theme") ?? "midnight";
document.documentElement.dataset.theme = saved;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
