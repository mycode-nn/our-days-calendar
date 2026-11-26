import { readFileSync, mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const root = new URL("../", import.meta.url).pathname;
const read = p => readFileSync(join(root, p), "utf8");
const page = read("worker/page.html").replace("<!-- CSS -->", `<style>${read("worker/style.css")}</style>`).replace("<!-- JS -->", `<script>${read("worker/i18n.js")}</script><script>${read("worker/app.js")}</script>`);
rmSync(join(root,"dist"),{recursive:true,force:true});
mkdirSync(join(root,"dist/server"),{recursive:true});
writeFileSync(join(root,"dist/server/index.js"),`const PAGE = ${JSON.stringify(page)};\n${read("worker/index.js")}`);
const hostingConfig = join(root,".openai/hosting.json");
if (existsSync(hostingConfig)) {
  mkdirSync(join(root,"dist/.openai"),{recursive:true});
  copyFileSync(hostingConfig,join(root,"dist/.openai/hosting.json"));
}
console.log("Built",join(root,"dist"));
