import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { markStartup } from "./lib/startupProfile";
import "./styles.css";

markStartup("app:entry");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
