import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.GITHUB_PAGES ? "/op-calibration-reading-tool/" : "/",
});
