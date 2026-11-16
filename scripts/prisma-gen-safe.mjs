#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const IS_WIN = process.platform === "win32";
const NPX_BIN = IS_WIN ? "npx.cmd" : "npx";

const res = spawnSync(NPX_BIN, ["prisma", "generate"], {
  encoding: "utf8",
  shell: IS_WIN,
});

if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);

if (res.status === 0) {
  process.exit(0);
}

const combined = `${res.stdout || ""}\n${res.stderr || ""}`;
if (IS_WIN && combined.includes("EPERM") && combined.includes("query_engine-windows.dll.node")) {
  const clientDir = path.join(ROOT, "node_modules", ".prisma", "client");
  const dtsPath = path.join(clientDir, "index.d.ts");
  const dllPath = path.join(clientDir, "query_engine-windows.dll.node");

  if (fs.existsSync(clientDir)) {
    for (const file of fs.readdirSync(clientDir)) {
      if (file.includes(".tmp")) {
        try {
          fs.unlinkSync(path.join(clientDir, file));
        } catch {
          // Ignore locked temp file
        }
      }
    }
  }

  if (fs.existsSync(dtsPath) && fs.existsSync(dllPath)) {
    console.log(
      "[prisma-gen-safe] Client TypeScript généré ; query_engine-windows.dll.node déjà actif en mémoire."
    );
    process.exit(0);
  }
}

process.exit(res.status ?? 1);
