import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { loadConfig } from "./server/config";

export default defineConfig(() => {
  const config = loadConfig();

  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("./client", import.meta.url)) } },
    test: { setupFiles: ["./client/test-setup.ts"] },
    build: { outDir: "dist/client" },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": `http://127.0.0.1:${config.PORT}`,
      },
    },
  };
});
