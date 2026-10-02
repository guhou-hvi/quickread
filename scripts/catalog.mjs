import fs from "node:fs/promises";
import path from "node:path";
import { CASES_ROOT, REPO_ROOT, isMain, readJson, writeText } from "./lib.mjs";

const REQUIRED_OUTPUTS = [
  ["深度稿", "output/deep-read.md"],
  ["HTML", "output/quickread.html"],
  ["桌面 PNG", "output/quickread.png"],
  ["手机 PNG", "output/quickread-mobile.png"],
];

const READER_OUTPUTS = [["证据册", "output/evidence-book.md"]];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function markdownCell(value) {
  return String(value ?? "—").replaceAll("|", "\\|").replace(/\s+/g, " ").trim() || "—";
}

function relativeHref(caseId, relativePath) {
  return `${encodeURIComponent(caseId)}/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function optionalJson(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function loadCatalogCases(casesRoot = CASES_ROOT) {
  const entries = await fs.readdir(casesRoot, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const caseDir = path.join(casesRoot, entry.name);
    const manifestPath = path.join(caseDir, "case.json");
    if (!(await exists(manifestPath))) continue;
    const manifest = await readJson(manifestPath);
    const outputs = [];
    for (const [label, relativePath] of REQUIRED_OUTPUTS) {
      if (await exists(path.join(caseDir, ...relativePath.split("/")))) outputs.push({ label, relativePath });
    }
    for (const [label, relativePath] of READER_OUTPUTS) {
      if (await exists(path.join(caseDir, ...relativePath.split("/")))) outputs.push({ label, relativePath });
    }
    const outputNames = await fs.readdir(path.join(caseDir, "output")).catch(() => []);
    for (const name of outputNames.filter((value) => /^quickread-mobile-\d{2}\.png$/i.test(value)).sort()) {
      outputs.push({ label: `手机分段 ${name.match(/(\d{2})/)?.[1]}`, relativePath: `output/${name}` });
    }
    const quality = await optionalJson(path.join(caseDir, "work", "quality-report.json"));
    records.push({ manifest, caseDir, outputs, quality });
  }
  return records.sort((a, b) => b.manifest.caseNumber.localeCompare(a.manifest.caseNumber));
}

function sourceLabel(source) {
  return {
    verified: "已核验",
    pending: "来源待确认",
    missing: "尚未检索",
    "not-applicable": "不适用",
  }[source.urlStatus] ?? "状态未知";
}

function readerLengthLabel(quality) {
  return quality?.readerEdition
    ? `${quality.readerEdition.bodyCharacters.toLocaleString("zh-CN")} / ${quality.readerEdition.recommendedCharacters.toLocaleString("zh-CN")}`
    : quality?.deepRead
      ? `${(quality.deepRead.actualRetention * 100).toFixed(1)}% / ${(quality.deepRead.targetRetention * 100).toFixed(1)}%`
    : "待生成";
}

function semanticCoverageLabel(quality) {
  if (!quality?.readerEdition) return "待生成";
  const adjudicated = quality.readerEdition.adjudicatedSemanticCoverage
    ?? quality.readerEdition.highMediumSemanticCoverage;
  const declared = quality.readerEdition.declaredReferenceCoverage;
  if (!Number.isFinite(adjudicated)) return "待多代理审核";
  const value = Number.isFinite(declared)
    ? `裁决 ${(adjudicated * 100).toFixed(0)}% · 声明 ${(declared * 100).toFixed(0)}%`
    : `${(adjudicated * 100).toFixed(0)}%`;
  return quality.humanReview?.status === "pass" ? value : `${value}（待人工确认）`;
}

function auditState(quality, manifest = null, config = null) {
  if (config?.migration?.frozenCases?.includes(manifest?.caseNumber)) return "frozen";
  if (!quality) return "pending";
  const automatedErrors = (quality.errors ?? []).filter((error) => !/(?:人工|用户集中).*校审|人工六维评分/u.test(error));
  if (!automatedErrors.length && quality.humanReview?.status === "pending") return "human-pending";
  return quality.status === "pass" ? "pass" : "fail";
}

function auditLabel(quality, manifest = null, config = null) {
  const state = auditState(quality, manifest, config);
  if (state === "frozen") return `${manifest?.workflow?.version ?? "旧版"} 基线冻结`;
  return { pending: "待审计", "human-pending": "待人工校审", pass: "通过", fail: "未通过" }[state];
}

export async function catalogArtifacts(casesRoot = CASES_ROOT) {
  const [records, config] = await Promise.all([
    loadCatalogCases(casesRoot),
    readJson(path.join(REPO_ROOT, "config", "pipeline.json")),
  ]);
  const rows = records.map(({ manifest, outputs, quality }) => {
    const localLinks = outputs.map(({ label, relativePath }) =>
      `[${label}](${relativeHref(manifest.id, relativePath)})`).join(" · ") || "—";
    const source = manifest.source.urlStatus === "verified" && manifest.source.url
      ? `[原视频](${manifest.source.url})`
      : sourceLabel(manifest.source);
    const profile = manifest.profile?.primary ?? "待确认";
    const lenses = (manifest.profile?.lenses ?? []).join("、") || "无 lens";
    return `| ${manifest.caseNumber} | **${markdownCell(manifest.shortTitle)}**<br>${markdownCell(manifest.title)} | ${markdownCell(manifest.participants.join("、"))} | ${markdownCell(profile)}<br>${markdownCell(lenses)} | ${readerLengthLabel(quality)} | ${semanticCoverageLabel(quality)} | ${auditLabel(quality, manifest, config)} | ${markdownCell(manifest.source.publisher)} | ${markdownCell(manifest.source.publishedAt)} | ${markdownCell(manifest.source.duration)} | ${markdownCell(manifest.tags.join("、"))} | ${source} | ${localLinks} |`;
  }).join("\n");
  const markdown = `# QuickRead 案例目录\n\n> 此文件由 \`npm run catalog\` 确定性生成，请勿手工编辑。案例按归档编号倒序排列。\n\n| 编号 | 案例与原始标题 | 人物 | Profile / Lens | 读者版字符 实际/建议 | 高中覆盖（裁决/声明） | 审计 | 发布方 | 发布日期 | 时长 | 标签 | 原始来源 | 交付物 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n${rows}\n`;

  const cards = records.map(({ manifest, outputs, quality }) => {
    const profile = manifest.profile?.primary ?? "pending";
    const auditStatus = auditState(quality, manifest, config);
    const search = [
      manifest.caseNumber,
      manifest.shortTitle,
      manifest.title,
      ...manifest.participants,
      manifest.source.publisher,
      profile,
      ...(manifest.profile?.lenses ?? []),
      ...manifest.tags,
      ...manifest.aliases,
    ].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
    const outputLinks = outputs.map(({ label, relativePath }) =>
      `<a href="${relativeHref(manifest.id, relativePath)}">${escapeHtml(label)}</a>`).join("");
    const sourceLink = manifest.source.urlStatus === "verified" && manifest.source.url
      ? `<a class="source verified" href="${escapeHtml(manifest.source.url)}" target="_blank" rel="noreferrer">打开原视频</a>`
      : `<span class="source ${escapeHtml(manifest.source.urlStatus)}">${escapeHtml(sourceLabel(manifest.source))}</span>`;
    const tags = manifest.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
    return `<article class="case-card" data-search="${escapeHtml(search)}" data-status="${escapeHtml(manifest.source.urlStatus)}" data-profile="${escapeHtml(profile)}" data-audit="${escapeHtml(auditStatus)}">
      <div class="case-number">${escapeHtml(manifest.caseNumber)}</div>
      <h2>${escapeHtml(manifest.shortTitle)}</h2>
      <p class="original-title">${escapeHtml(manifest.title)}</p>
      <dl><div><dt>人物</dt><dd>${escapeHtml(manifest.participants.join("、") || "待补充")}</dd></div><div><dt>Profile</dt><dd>${escapeHtml(profile)} · ${escapeHtml((manifest.profile?.lenses ?? []).join("、") || "无 lens")}</dd></div><div><dt>读者版</dt><dd>${escapeHtml(readerLengthLabel(quality))} 字符</dd></div><div><dt>语义覆盖</dt><dd>${escapeHtml(semanticCoverageLabel(quality))}</dd></div><div><dt>审计</dt><dd>${escapeHtml(auditLabel(quality, manifest, config))}</dd></div><div><dt>发布方</dt><dd>${escapeHtml(manifest.source.publisher || "待补充")}</dd></div><div><dt>日期</dt><dd>${escapeHtml(manifest.source.publishedAt || "待补充")}</dd></div><div><dt>时长</dt><dd>${escapeHtml(manifest.source.duration || "—")}</dd></div></dl>
      <div class="tags">${tags}</div>
      <div class="links">${sourceLink}${outputLinks}</div>
    </article>`;
  }).join("\n");

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QuickRead 案例目录</title>
<style>:root{color-scheme:light;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#20252b;background:#f4f6f8}*{box-sizing:border-box}body{margin:0}.shell{width:min(1180px,calc(100% - 32px));margin:40px auto 64px}header{display:flex;gap:24px;align-items:end;justify-content:space-between;margin-bottom:24px}h1{margin:0;font-size:clamp(28px,4vw,46px)}header p{margin:8px 0 0;color:#65707c}.controls{display:flex;gap:10px;flex-wrap:wrap}input,select{font:inherit;border:1px solid #ccd3da;border-radius:10px;background:#fff;padding:11px 13px}input{width:min(360px,75vw)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:16px}.case-card{position:relative;background:#fff;border:1px solid #dde2e7;border-radius:14px;padding:22px;box-shadow:0 8px 24px #18222c0d}.case-card[hidden]{display:none}.case-number{color:#d55e00;font-weight:800;letter-spacing:.1em;font-size:13px}.case-card h2{margin:8px 0 7px;font-size:21px}.original-title{min-height:44px;margin:0 0 16px;color:#5c6670;line-height:1.55}dl{margin:0;display:grid;gap:7px}dl div{display:grid;grid-template-columns:64px 1fr;gap:8px}dt{color:#7a8590}dd{margin:0}.tags,.links{display:flex;flex-wrap:wrap;gap:7px}.tags{margin-top:15px}.tags span{background:#f4f9fc;color:#005a8d;padding:4px 8px;border-radius:999px;font-size:12px}.links{margin-top:17px}.links a,.source{border:1px solid #d7dde3;border-radius:8px;padding:7px 9px;color:#34414d;text-decoration:none;font-size:13px}.source.pending,.source.missing{color:#934000;background:#fff8f3}.source.verified{color:#006a4e;background:#f3faf7}.empty{display:none;padding:40px;text-align:center;color:#65707c}.empty.visible{display:block}@media(max-width:680px){.shell{margin-top:24px}header{align-items:stretch;flex-direction:column}input,select{width:100%}}</style></head>
<body><main class="shell"><header><div><h1>QuickRead 案例目录</h1><p>${records.length} 个案例 · 按编号倒序</p></div><div class="controls"><input id="query" type="search" placeholder="搜索编号、人物、机构、主题…" aria-label="搜索案例"><select id="status" aria-label="来源状态"><option value="">全部来源状态</option><option value="verified">已核验</option><option value="pending">来源待确认</option><option value="missing">尚未检索</option><option value="not-applicable">不适用</option></select><select id="profile" aria-label="Profile"><option value="">全部 Profile</option><option value="knowledge">knowledge</option><option value="strategy">strategy</option><option value="narrative">narrative</option><option value="debate">debate</option><option value="general">general</option><option value="pending">待确认</option></select><select id="audit" aria-label="审计状态"><option value="">全部审计状态</option><option value="pass">通过</option><option value="human-pending">待人工校审</option><option value="frozen">迁移基线冻结</option><option value="fail">未通过</option><option value="pending">待审计</option></select></div></header><section class="grid" id="cases">${cards}</section><p class="empty" id="empty">没有匹配的案例。</p></main>
<script>(()=>{const q=document.querySelector('#query'),s=document.querySelector('#status'),p=document.querySelector('#profile'),a=document.querySelector('#audit'),cards=[...document.querySelectorAll('.case-card')],empty=document.querySelector('#empty');const apply=()=>{const term=q.value.trim().toLocaleLowerCase('zh-CN'),status=s.value,profile=p.value,audit=a.value;let visible=0;for(const card of cards){const show=(!term||card.dataset.search.includes(term))&&(!status||card.dataset.status===status)&&(!profile||card.dataset.profile===profile)&&(!audit||card.dataset.audit===audit);card.hidden=!show;if(show)visible++}empty.classList.toggle('visible',visible===0)};q.addEventListener('input',apply);s.addEventListener('change',apply);p.addEventListener('change',apply);a.addEventListener('change',apply)})()</script></body></html>\n`;
  return { records, markdown, html };
}

export async function writeCatalog(casesRoot = CASES_ROOT) {
  const { records, markdown, html } = await catalogArtifacts(casesRoot);
  await writeText(path.join(casesRoot, "README.md"), markdown);
  await writeText(path.join(casesRoot, "index.html"), html);
  return records;
}

export async function catalogErrors(casesRoot = CASES_ROOT) {
  const errors = [];
  const [expected, config] = await Promise.all([
    catalogArtifacts(casesRoot),
    readJson(path.join(REPO_ROOT, "config", "pipeline.json")),
  ]);
  for (const [name, content] of [["README.md", expected.markdown], ["index.html", expected.html]]) {
    const filePath = path.join(casesRoot, name);
    if (!(await exists(filePath))) errors.push(`缺少案例目录：cases/${name}`);
    else if (await fs.readFile(filePath, "utf8") !== content) errors.push(`案例目录已过期：cases/${name}`);
  }
  for (const { manifest, caseDir, quality } of expected.records) {
    if (manifest.source.urlStatus === "verified" && !manifest.source.url) errors.push(`${manifest.id} 来源状态为 verified 但缺少 URL。`);
    if (manifest.source.urlStatus !== "verified" && manifest.source.url) errors.push(`${manifest.id} 未核验来源不得生成正式 URL。`);
    const frozen = config.migration?.frozenCases?.includes(manifest.caseNumber);
    if (!quality && !frozen) errors.push(`${manifest.id} 缺少质量报告。`);
    for (const [label, relativePath] of REQUIRED_OUTPUTS) {
      if (!(await exists(path.join(caseDir, ...relativePath.split("/"))))) errors.push(`${manifest.id} 缺少${label}。`);
    }
    if (["2.1.0", "2.2.0"].includes(manifest.workflow?.version) && !(await exists(path.join(caseDir, "output", "evidence-book.md")))) errors.push(`${manifest.id} 缺少证据册。`);
  }
  return errors;
}

if (isMain(import.meta.url)) {
  const records = await writeCatalog();
  console.log(`已生成案例目录：${path.relative(REPO_ROOT, path.join(CASES_ROOT, "README.md"))}`);
  console.log(`已生成可搜索目录：${path.relative(REPO_ROOT, path.join(CASES_ROOT, "index.html"))}`);
  console.log(`共 ${records.length} 个案例。`);
}
