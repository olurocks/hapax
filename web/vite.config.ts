import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Repo root is readable so the app can import contracts/deployments/*.json and the shared package.
  server: { port: 5173, fs: { allow: [".."] } },
  envDir: "..",
});
