import vue from "@vitejs/plugin-vue";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue(), nitro()],
  resolve: {
    tsconfigPaths: true,
  },
});
