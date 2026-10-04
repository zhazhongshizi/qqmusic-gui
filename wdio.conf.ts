import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { WdioTauriConfig } from "@wdio/native-types";

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
const application = resolve(
  repositoryRoot,
  "src-tauri/target/x86_64-pc-windows-msvc/debug/qqmusic-gui.exe",
);

export const config: WdioTauriConfig = {
  runner: "local",
  specs: ["./e2e/specs/**/*.e2e.ts"],
  maxInstances: 1,
  maxInstancesPerCapability: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application,
      },
    },
  ],
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: application,
        captureBackendLogs: false,
        captureFrontendLogs: false,
        commandTimeout: 15_000,
        driverProvider: "embedded",
        embeddedPort: 4_445,
        logLevel: "warn",
        startTimeout: 60_000,
        statusPollTimeout: 5_000,
      },
    ],
  ],
  logLevel: "warn",
  bail: 1,
  waitforTimeout: 10_000,
  connectionRetryTimeout: 60_000,
  connectionRetryCount: 0,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 120_000,
  },
};
