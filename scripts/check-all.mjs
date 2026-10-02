import path from "node:path";
import { listCaseDirs, readJson } from "./lib.mjs";
import { printResult, validateCase } from "./validate-case.mjs";
import { catalogErrors } from "./catalog.mjs";

let failed = false;
const caseDirs = await listCaseDirs();
const manifests = [];
for (const caseDir of caseDirs) {
  const result = await validateCase(caseDir);
  manifests.push(result.manifest);
  printResult(result);
  if (result.errors.length) failed = true;
}
const numbers = manifests.map(manifest => Number(manifest.caseNumber?.slice(3))).sort((a, b) => a - b);
if (new Set(numbers).size !== numbers.length) {
  console.error("FAIL  案例编号存在重复。");
  failed = true;
}
for (let index = 0; index < numbers.length; index += 1) {
  if (numbers[index] !== index + 1) {
    console.error(`FAIL  案例编号不连续：期望 QR-${String(index + 1).padStart(4, "0")}。`);
    failed = true;
    break;
  }
}
const aliases = new Map();
for (const manifest of manifests) {
  for (const alias of manifest.aliases ?? []) {
    if (aliases.has(alias)) {
      console.error(`FAIL  案例别名重复：${alias}（${aliases.get(alias)} / ${manifest.id}）。`);
      failed = true;
    }
    aliases.set(alias, manifest.id);
  }
  if (manifest.id !== path.basename(caseDirs.find(caseDir => path.basename(caseDir) === manifest.id) ?? "")) {
    console.error(`FAIL  案例目录与 ID 不一致：${manifest.id}。`);
    failed = true;
  }
}
for (const error of await catalogErrors()) {
  console.error(`FAIL  ${error}`);
  failed = true;
}
if (failed) process.exitCode = 1;
