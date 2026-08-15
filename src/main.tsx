import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { markStartup } from "./lib/startupProfile";
// Display serif loads as a split chunk: the KR subset @font-face list alone
// is ~90 KiB of CSS per weight, which would blow the initial-CSS bundle
// budget if imported statically. font-display: swap covers the async arrive.
void import("@fontsource/noto-serif-kr/600.css");
void import("@fontsource/noto-serif-kr/700.css");
import "./foundations.css";
import "./styles.css";

markStartup("app:entry");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
