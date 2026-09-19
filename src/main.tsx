import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { createApp } from "./ui/appController";
import { MESSAGES } from "./ui/auth/messages";
import "./ui/styles.css";

const container = document.getElementById("root");
if (container === null) throw new Error("找不到 #root 容器");
const root = createRoot(container);

createApp({ activityTarget: window, visibilityTarget: document })
  .then(({ controller, storage }) =>
    root.render(
      <StrictMode>
        <App controller={controller} storage={storage} />
      </StrictMode>
    )
  )
  .catch(() =>
    root.render(
      <main className="auth-card">
        <p role="alert">{MESSAGES.bootFailed}</p>
      </main>
    )
  );
