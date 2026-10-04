import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "src-tauri/remote-dist",
    emptyOutDir: true,
    lib: { entry: "src/remote/main.tsx", name: "MusicRemote", formats: ["iife"], fileName: () => "remote.js", cssFileName: "remote" },
  },
});
