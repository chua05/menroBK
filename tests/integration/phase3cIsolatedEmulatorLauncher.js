const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const ports = [9299, 8281, 9298, 4401];
const root = path.join(os.tmpdir(), `menro-phase3c-isolated-${randomUUID()}`);
const statePath = path.join(root, "launcher.json");
const free = port => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject); server.once("listening", () => server.close(resolve));
  server.listen(port, "127.0.0.1");
});
async function main() {
  assert.equal(process.env.GCLOUD_PROJECT || "demo-menro-phase3c-isolated", "demo-menro-phase3c-isolated");
  for (const key of ["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_PRIVATE_KEY", "FIREBASE_CLIENT_EMAIL", "FIREBASE_CONFIG"]) assert.equal(process.env[key], undefined);
  await Promise.all(ports.map(free));
  await fs.mkdir(root, { recursive: true });
  const emulatorArgs = ["emulators:start", "--only", "auth,firestore,storage", "--config", "tests/integration/firebase.phase3c-isolated.json", "--project", "demo-menro-phase3c-isolated", "--export-on-exit", path.join(root, "export")];
  const child = process.platform === "win32"
    ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `firebase ${emulatorArgs.join(" ")}`], { cwd: path.resolve(__dirname, "../.."), stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    : spawn("firebase", emulatorArgs, { cwd: path.resolve(__dirname, "../.."), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  await new Promise((resolve, reject) => child.once("spawn", resolve).once("error", reject));
  const output = require("node:fs").createWriteStream(path.join(root, "firebase.log"), { flags: "a" });
  child.stdout.pipe(output); child.stderr.pipe(output);
  await fs.writeFile(statePath, JSON.stringify({ pid: child.pid, root, ports }), "utf8");
  child.once("exit", () => fs.rm(statePath, { force: true }).catch(() => undefined));
  process.stdout.write(`${JSON.stringify({ pid: child.pid, root, ports })}\n`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
