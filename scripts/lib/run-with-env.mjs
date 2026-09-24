// run-with-env.mjs: portable `NAME=value cmd args` for npm scripts (cmd.exe has no inline env syntax).
// Usage: node scripts/lib/run-with-env.mjs RUN_LIVE=1 [MORE=x] -- vitest run tests/integration
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 1 || sep === argv.length - 1) {
  console.error("usage: node scripts/lib/run-with-env.mjs NAME=value [...] -- command [args...]");
  process.exit(2);
}
const env = { ...process.env };
for (const pair of argv.slice(0, sep)) {
  const i = pair.indexOf("=");
  if (i < 1) {
    console.error(`[run-with-env] not NAME=value: ${pair}`);
    process.exit(2);
  }
  env[pair.slice(0, i)] = pair.slice(i + 1);
}
const [cmd, ...args] = argv.slice(sep + 1);
const child = spawn(cmd, args, { stdio: "inherit", env, shell: process.platform === "win32" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
