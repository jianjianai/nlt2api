import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { nitro } from "nitro/vite";

export default defineConfig({
  plugins: [
    vue(),
    nitro(),
  ],
  resolve: {
    tsconfigPaths: true
  }
});
