import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const configDir = path.resolve(process.env.MES_CONFIG_DIR || path.join(root, "config"));
await mkdir(configDir, { recursive: true });

for (const [source, name] of [
  ["dashboard.json", "dashboard.json"],
  ["mfg-api.example.json", "mfg-api.json"],
]) {
  const target = path.join(configDir, name);
  try {
    await writeFile(target, await readFile(path.join(root, "config", source)), { flag: "wx", mode: 0o600 });
    console.log(`Created ${target}`);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.log(`Kept existing ${target}`);
  }
}

console.log("Set oauth.clientId and oauth.clientSecret in mfg-api.json, or copy that file from your existing server.");
console.log("Then run npm run check:config before npm run dev or npm start.");
