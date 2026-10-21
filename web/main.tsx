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
 * every page load flash. With nothing saved, the browser's own
 * light-or-dark preference decides — otherwise a first-time daytime visitor
 * saw the sign-in page in dark-on-dark whatever their OS said.
 */
const saved =
  localStorage.getItem("tnui:theme") ??
  (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "daylight" : "midnight");
document.documentElement.dataset.theme = saved;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
