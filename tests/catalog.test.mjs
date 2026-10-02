import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { catalogArtifacts, catalogErrors, writeCatalog } from "../scripts/catalog.mjs";
import { listCaseDirs } from "../scripts/lib.mjs";

test("fresh checkout can create an empty catalog and ignore staging directories", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-empty-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cases = path.join(root, "cases");
  assert.deepEqual(await listCaseDirs(cases), []);
  await writeCatalog(cases);
  assert.deepEqual(await catalogErrors(cases), []);
  await fs.mkdir(path.join(cases, ".staging"));
  assert.deepEqual(await listCaseDirs(cases), []);
});

async function makeCase(casesRoot, manifest) {
  const caseDir = path.join(casesRoot, manifest.id);
  await fs.mkdir(path.join(caseDir, "output"), { recursive: true });
  await fs.writeFile(path.join(caseDir, "case.json"), JSON.stringify(manifest), "utf8");
  for (const name of ["deep-read.md", "quickread.html", "quickread.png", "quickread-mobile.png"]) {
    await fs.writeFile(path.join(caseDir, "output", name), name, "utf8");
  }
  await fs.mkdir(path.join(caseDir, "work"), { recursive: true });
  await fs.writeFile(path.join(caseDir, "work", "quality-report.json"), JSON.stringify({
    status: "pass",
    deepRead: { actualRetention: 0.42, targetRetention: 0.5 },
  }), "utf8");
}

function manifest(number, descriptor, overrides = {}) {
  const digits = String(number).padStart(4, "0");
  return {
    id: `qr-${digits}-${descriptor}`,
    caseNumber: `QR-${digits}`,
    shortTitle: overrides.shortTitle ?? "测试短标题",
    title: overrides.title ?? "测试原始视频标题",
    participants: overrides.participants ?? ["测试嘉宾"],
    aliases: overrides.aliases ?? [],
    tags: overrides.tags ?? ["人工智能"],
    profile: overrides.profile ?? { primary: "knowledge", lenses: ["research"], selection: "auto", confidence: 0.9, version: "1.0.0" },
    source: {
      publisher: overrides.publisher ?? "测试节目",
      publishedAt: "2026-07-31",
      duration: "01:00:00.000",
      url: overrides.url ?? null,
      urlStatus: overrides.urlStatus ?? "pending",
    },
  };
}

test("catalog is deterministic, searchable, sorted by number, and only links verified sources", async () => {
  const casesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-catalog-"));
  try {
    await makeCase(casesRoot, manifest(1, "first-topic", { aliases: ["old-first"], urlStatus: "pending" }));
    await makeCase(casesRoot, manifest(2, "wang-ai", {
      shortTitle: "王老师：AI",
      title: "对话王老师",
      participants: ["王老师"],
      tags: ["AI", "研究"],
      urlStatus: "verified",
      url: "https://example.com/video",
    }));
    const first = await catalogArtifacts(casesRoot);
    const second = await catalogArtifacts(casesRoot);
    assert.equal(first.markdown, second.markdown);
    assert.equal(first.html, second.html);
    assert.ok(first.markdown.indexOf("QR-0002") < first.markdown.indexOf("QR-0001"));
    assert.match(first.html, /data-search="[^"]*王老师[^"]*ai[^"]*研究/);
    assert.match(first.html, /data-profile="knowledge"/);
    assert.match(first.html, /data-audit="pass"/);
    assert.match(first.markdown, /42\.0% \/ 50\.0%/);
    assert.match(first.html, /data-search="[^"]*old-first/);
    assert.match(first.html, /href="https:\/\/example\.com\/video"/);
    assert.doesNotMatch(first.html, /class="source pending" href=/);
    assert.match(first.html, /来源待确认/);

    await writeCatalog(casesRoot);
    assert.deepEqual(await catalogErrors(casesRoot), []);
    await fs.appendFile(path.join(casesRoot, "README.md"), "stale", "utf8");
    assert.match((await catalogErrors(casesRoot)).join(" "), /案例目录已过期/);
  } finally {
    await fs.rm(casesRoot, { recursive: true, force: true });
  }
});
