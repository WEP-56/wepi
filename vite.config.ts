import path from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// package.json 版本：编译期注入为全局常量，浏览器预览时关于页显示它。
// 桌面端运行时会再用 Tauri getVersion() 覆盖（真实来源是 tauri.conf.json）。
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8"));

// https://vite.dev/config/
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/.cargo-cache/**"] },
  },
  plugins: [react(), tailwindcss(), viteSingleFile()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
