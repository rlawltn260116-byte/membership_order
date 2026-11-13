import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function lookupBofeelPostcodes(keywords, { env = process.env, execute = execFile } = {}) {
  if (env.ENABLE_B2B_HTTP_CART !== "true" || !keywords.length || keywords.length > 30) return [];
  const childEnv = { ENABLE_B2B_HTTP_CART: env.ENABLE_B2B_HTTP_CART, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" };
  for (const key of ["PATH", "SYSTEMROOT", "TEMP", "TMP", "HOME", "LANG"]) if (env[key] !== undefined) childEnv[key] = env[key];
  return await new Promise(resolve => {
    try {
      const child = execute(env.B2B_HTTP_PYTHON || (process.platform === "win32" ? "python" : "python3"),
        ["-B", "-X", "utf8", fileURLToPath(new URL("./http_postcode.py", import.meta.url))],
        { env: childEnv, timeout: 180_000, maxBuffer: 1_000_000, windowsHide: true }, (error, stdout) => {
          if (error) return resolve([]);
          try { const results = JSON.parse(stdout); resolve(Array.isArray(results) && results.length === keywords.length ? results : []); }
          catch { resolve([]); }
        });
      child.stdin.on("error", () => resolve([]));
      child.stdin.end(JSON.stringify(keywords) + "\n");
    } catch { resolve([]); }
  });
}
