import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2020",
  platform: "neutral",
  treeshake: true,
  // zod is a peer dependency: always load the copy the app installed, never bundle it.
  external: [/^zod(\/.*)?$/],
});
