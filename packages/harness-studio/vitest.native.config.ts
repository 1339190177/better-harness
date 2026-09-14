import { defineConfig } from "vitest/config";

export default defineConfig({ test: {
  environment: "node", include: [
    "test/agent-react/rust-oxc.native.ts",
    "test/agent-react/go-esbuild.native.ts",
    "test/acp-rust.native.ts",
    "test/structural-diff.native.ts",
  ],
  pool: "forks", testTimeout: 30_000,
} });
