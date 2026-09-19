import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages 部署於 https://<帳號>.github.io/pw-manager/ 子路徑：只有 build 套用，本機 dev 維持 '/'
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/pw-manager/" : "/",
  plugins: [react()],
}));
