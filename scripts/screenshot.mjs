import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import {
  isMain,
  readJson,
  REPO_ROOT,
  resolveCaseDir,
  writeJson,
} from "./lib.mjs";

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

async function findBrowser() {
  for (const candidate of EDGE_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue to the next known system browser.
    }
  }
  throw new Error("未找到 Edge/Chrome。请在 config 中补充浏览器路径。");
}

async function inspectLayout(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const sectionLead = document.querySelector(".section-lead");
    const titleMarkElement = document.querySelector(".title-mark");
    const titleMarkRect = titleMarkElement?.getBoundingClientRect();
    const markerMetrics = (selector, pseudoElement) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element, pseudoElement);
      return {
        width: Number.parseFloat(style.width),
        height: Number.parseFloat(style.height),
        borderRadius: style.borderRadius,
        backgroundColor: style.backgroundColor,
      };
    };
    const blockLabelMarker = markerMetrics(".block-label", "::before");
    const bulletMarker = markerMetrics(".bullet-list li", "::before");
    const hierarchyMarkers = {
      blockLabel: blockLabelMarker,
      bullet: bulletMarker,
      distinctShape: blockLabelMarker && bulletMarker
        ? blockLabelMarker.width !== bulletMarker.width ||
          blockLabelMarker.height !== bulletMarker.height ||
          blockLabelMarker.borderRadius !== bulletMarker.borderRadius
        : null,
    };
    const stepMeasurements = [...document.querySelectorAll(".step-item")].map((item) => {
      const number = item.querySelector(".step-number");
      const text = item.querySelector(".step-text");
      const textNode = text
        ? [...text.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && /\S/.test(node.textContent ?? ""))
        : null;
      if (!number || !textNode) return null;
      const firstCharacterIndex = textNode.textContent.search(/\S/);
      const firstCharacter = [...textNode.textContent.slice(firstCharacterIndex)][0];
      const range = document.createRange();
      range.setStart(textNode, firstCharacterIndex);
      range.setEnd(textNode, firstCharacterIndex + firstCharacter.length);
      const numberRect = number.getBoundingClientRect();
      const glyphRect = range.getBoundingClientRect();
      return Math.abs(
        ((numberRect.top + numberRect.bottom) - (glyphRect.top + glyphRect.bottom)) / 2,
      );
    });
    const validStepMeasurements = stepMeasurements.filter((value) => value !== null);
    const stepAlignment = {
      count: stepMeasurements.length,
      missingText: stepMeasurements.length - validStepMeasurements.length,
      maxFirstLineCenterDelta: validStepMeasurements.length
        ? Math.round(Math.max(...validStepMeasurements) * 1000) / 1000
        : 0,
    };
    const bad = [...document.querySelectorAll("[data-component]")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          component: element.getAttribute("data-component"),
          left: rect.left,
          right: rect.right,
          width: rect.width,
          height: rect.height,
        };
      })
      .filter((item) => item.left < -0.5 || item.right > root.clientWidth + 0.5 || item.width <= 0 || item.height <= 0);
    return {
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
      scrollHeight: root.scrollHeight,
      fontMetrics: {
        rootPx: Number.parseFloat(getComputedStyle(root).fontSize),
        sectionLeadPx: sectionLead
          ? Number.parseFloat(getComputedStyle(sectionLead).fontSize)
          : null,
      },
      titleMark: titleMarkRect ? {
        left: titleMarkRect.left,
        right: titleMarkRect.right,
        width: titleMarkRect.width,
        height: titleMarkRect.height,
        ariaHidden: titleMarkElement.getAttribute("aria-hidden"),
        hasCore: Boolean(titleMarkElement.querySelector(".title-mark-core")),
      } : null,
      hierarchyMarkers,
      stepAlignment,
      bad,
    };
  });
}

export function chooseSegmentBreaks(totalCssHeight, safeBreaks, deviceScaleFactor, targetPhysicalHeight, maximumPhysicalHeight) {
  const targetCssHeight = targetPhysicalHeight / deviceScaleFactor;
  const maximumCssHeight = maximumPhysicalHeight / deviceScaleFactor;
  const candidates = [...new Set(safeBreaks)]
    .filter((value) => Number.isFinite(value) && value > 0 && value < totalCssHeight)
    .sort((a, b) => a - b);
  const boundaries = [0];
  let start = 0;
  while (totalCssHeight - start > maximumCssHeight) {
    const target = start + targetCssHeight;
    const maximum = start + maximumCssHeight;
    const preferred = candidates.filter((value) => value > start + 200 && value <= target).at(-1);
    const fallback = candidates.filter((value) => value > start + 200 && value <= maximum).at(-1);
    const next = preferred ?? fallback ?? Math.min(maximum, totalCssHeight);
    if (next <= start) break;
    boundaries.push(next);
    start = next;
  }
  boundaries.push(totalCssHeight);
  return boundaries;
}

export function segmentClipBounds(start, end, actualCssHeight) {
  const clipStart = Math.max(0, Math.floor(start));
  const clipEnd = Math.min(Math.max(0, actualCssHeight - 1), Math.floor(end));
  if (clipEnd <= clipStart) return null;
  return { start: clipStart, end: clipEnd, height: clipEnd - clipStart };
}

async function clearSegmentedMobilePngs(outputDir) {
  const entries = await fs.readdir(outputDir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  await Promise.all(entries
    .filter((name) => /^quickread-mobile-\d{2}\.png$/i.test(name))
    .map((name) => fs.unlink(path.join(outputDir, name))));
}

async function captureSegmentedMobilePngs(page, caseDir, config, totalCssHeight) {
  const outputDir = path.join(caseDir, "output");
  await clearSegmentedMobilePngs(outputDir);
  if (totalCssHeight * config.deviceScaleFactor <= config.warningHeight) return [];
  const safeBreaks = await page.evaluate(() => {
    const selectors = [
      ".masthead",
      ".hero-summary",
      ".time-anchors",
      ".content-block",
      ".quick-section",
      ".sources",
      ".footer",
    ];
    return [...document.querySelectorAll(selectors.join(","))]
      .map((element) => element.getBoundingClientRect().bottom + window.scrollY)
      .filter((value) => value > 0 && value < document.documentElement.scrollHeight);
  });
  const boundaries = chooseSegmentBreaks(
    totalCssHeight,
    safeBreaks,
    config.deviceScaleFactor,
    config.segmentTargetHeight,
    config.segmentMaximumHeight,
  );
  const results = [];
  const actualCssHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const fullImageUrl = pathToFileURL(path.join(outputDir, "quickread-mobile.png")).href;
  await page.setContent(`<!doctype html>
    <html>
      <head>
        <style>
          html, body { margin: 0; width: ${config.viewportCssWidth}px; overflow: hidden; background: white; }
          #segment-source { position: absolute; left: 0; top: 0; width: ${config.viewportCssWidth}px; height: auto; }
        </style>
      </head>
      <body><img id="segment-source" alt="" src="${fullImageUrl}"></body>
    </html>`);
  await page.locator("#segment-source").evaluate((image) => image.decode());
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const clip = segmentClipBounds(start, end, actualCssHeight);
    if (!clip) continue;
    const clipStart = clip.start;
    const clipEnd = clip.end;
    const fileName = `quickread-mobile-${String(index + 1).padStart(2, "0")}.png`;
    const filePath = path.join(outputDir, fileName);
    const clipHeight = clip.height;
    await page.setViewportSize({ width: config.viewportCssWidth, height: clipHeight });
    await page.locator("#segment-source").evaluate((image, offset) => {
      image.style.top = `-${offset}px`;
    }, clipStart);
    let bytes;
    try {
      bytes = await page.screenshot({
        path: filePath,
        type: "png",
        captureBeyondViewport: false,
      });
    } catch (error) {
      throw new Error(
        `${fileName} 分段裁切失败：clip=${clipStart}–${clipEnd} CSS px，页面高度=${actualCssHeight} CSS px。\n${error.message}`,
      );
    }
    results.push({
      path: `output/${fileName}`,
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      startCssY: clipStart,
      endCssY: clipEnd,
    });
  }
  return results;
}

export function hierarchyLayoutErrors(label, layout) {
  const errors = [];
  if (layout.stepAlignment.missingText) {
    errors.push(`${label}存在 ${layout.stepAlignment.missingText} 个无法测量首行文字的步骤。`);
  }
  if (layout.stepAlignment.maxFirstLineCenterDelta > 1) {
    errors.push(`${label}步骤编号与首行文字中心偏差 ${layout.stepAlignment.maxFirstLineCenterDelta}px，超过 1px。`);
  }
  if (layout.hierarchyMarkers.distinctShape === false) {
    errors.push(`${label}模块小标题与正文列表使用了相同形态的标记。`);
  }
  return errors;
}

export async function screenshotCase(caseDir) {
  const config = await readJson(path.join(REPO_ROOT, "config", "pipeline.json"));
  const htmlPath = path.join(caseDir, "output", "quickread.html");
  await fs.access(htmlPath);
  const browserPath = await findBrowser();
  const browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: ["--disable-gpu", "--font-render-hinting=none"],
  });
  try {
    const desktopContext = await browser.newContext({
      viewport: { width: config.render.viewportCssWidth, height: 1000 },
      deviceScaleFactor: config.render.deviceScaleFactor,
    });
    const desktop = await desktopContext.newPage();
    await desktop.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await desktop.evaluate(() => document.fonts.ready);
    const desktopLayout = await inspectLayout(desktop);
    const outputPath = path.join(caseDir, "output", "quickread.png");
    const bytes = await desktop.screenshot({ path: outputPath, fullPage: true, type: "png" });
    const pngWidth = bytes.readUInt32BE(16);
    const pngHeight = bytes.readUInt32BE(20);
    await desktopContext.close();

    const mobileContext = await browser.newContext({
      viewport: { width: config.render.mobileCssWidth, height: 844 },
      deviceScaleFactor: 1,
    });
    const mobile = await mobileContext.newPage();
    await mobile.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await mobile.evaluate(() => document.fonts.ready);
    const mobileLayout = await inspectLayout(mobile);
    await mobileContext.close();

    const mobilePngConfig = config.render.mobilePng;
    const mobilePngContext = await browser.newContext({
      viewport: { width: mobilePngConfig.viewportCssWidth, height: 1000 },
      deviceScaleFactor: mobilePngConfig.deviceScaleFactor,
    });
    const mobilePngPage = await mobilePngContext.newPage();
    await mobilePngPage.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await mobilePngPage.evaluate(() => {
      document.documentElement.dataset.exportTarget = "mobile-png";
    });
    await mobilePngPage.evaluate(() => document.fonts.ready);
    const mobilePngLayout = await inspectLayout(mobilePngPage);
    const mobileOutputPath = path.join(caseDir, "output", "quickread-mobile.png");
    const mobileBytes = await mobilePngPage.screenshot({
      path: mobileOutputPath,
      fullPage: true,
      type: "png",
    });
    const mobilePngWidth = mobileBytes.readUInt32BE(16);
    const mobilePngHeight = mobileBytes.readUInt32BE(20);
    const mobilePngSegments = await captureSegmentedMobilePngs(
      mobilePngPage,
      caseDir,
      mobilePngConfig,
      mobilePngLayout.scrollHeight,
    );
    await mobilePngContext.close();

    const mobileEffectiveBodyFont = mobilePngLayout.fontMetrics.sectionLeadPx === null
      ? null
      : Math.round(
        mobilePngLayout.fontMetrics.sectionLeadPx
          * mobilePngConfig.referenceDisplayCssWidth
          / mobilePngConfig.viewportCssWidth
          * 1000,
      ) / 1000;

    const errors = [];
    const warnings = [];
    if (pngWidth !== config.render.pngWidth) errors.push(`PNG 宽度 ${pngWidth}，期望 ${config.render.pngWidth}。`);
    if (mobilePngWidth !== mobilePngConfig.pngWidth) {
      errors.push(`手机 PNG 宽度 ${mobilePngWidth}，期望 ${mobilePngConfig.pngWidth}。`);
    }
    if (desktopLayout.scrollWidth > desktopLayout.clientWidth) errors.push("桌面视口发生横向溢出。");
    if (mobileLayout.scrollWidth > mobileLayout.clientWidth) errors.push("移动视口发生横向溢出。");
    if (mobilePngLayout.scrollWidth > mobilePngLayout.clientWidth) errors.push("手机 PNG 发生横向溢出。");
    if (mobilePngLayout.fontMetrics.sectionLeadPx === null) {
      errors.push("手机 PNG 缺少可测量的正文。");
    } else if (mobileEffectiveBodyFont < mobilePngConfig.minimumEffectiveBodyFontCssPx) {
      errors.push(
        `手机 PNG 正文等效字号 ${mobileEffectiveBodyFont}px，低于 ${mobilePngConfig.minimumEffectiveBodyFontCssPx}px。`,
      );
    }
    if (Math.abs(mobilePngLayout.fontMetrics.rootPx - mobilePngConfig.rootFontCssPx) > 0.01) {
      errors.push(
        `手机 PNG 根字号 ${mobilePngLayout.fontMetrics.rootPx}px，期望 ${mobilePngConfig.rootFontCssPx}px。`,
      );
    }
    if (!desktopLayout.titleMark?.hasCore || desktopLayout.titleMark?.ariaHidden !== "true") {
      errors.push("标题扫描标缺少中心结构或 aria-hidden。 ");
    }
    if (Math.abs((desktopLayout.titleMark?.width ?? 0) - 420) > 1) {
      errors.push(`桌面标题扫描标宽度 ${desktopLayout.titleMark?.width ?? 0}px，期望约 420px。`);
    }
    if ((mobileLayout.titleMark?.width ?? 0) < 220 || (mobileLayout.titleMark?.right ?? Infinity) > mobileLayout.clientWidth) {
      errors.push("移动端标题扫描标未保持 220px 最小宽度或超出视口。");
    }
    if ((mobilePngLayout.titleMark?.width ?? 0) < 220 || (mobilePngLayout.titleMark?.right ?? Infinity) > mobilePngLayout.clientWidth) {
      errors.push("手机 PNG 标题扫描标未保持 220px 最小宽度或超出视口。");
    }
    errors.push(...hierarchyLayoutErrors("桌面", desktopLayout));
    errors.push(...hierarchyLayoutErrors("移动端", mobileLayout));
    errors.push(...hierarchyLayoutErrors("手机 PNG", mobilePngLayout));
    if (desktopLayout.bad.length) errors.push(`桌面存在 ${desktopLayout.bad.length} 个越界/空组件。`);
    if (mobileLayout.bad.length) errors.push(`移动端存在 ${mobileLayout.bad.length} 个越界/空组件。`);
    if (mobilePngLayout.bad.length) errors.push(`手机 PNG 存在 ${mobilePngLayout.bad.length} 个越界/空组件。`);
    if (pngHeight < config.render.targetHeightMin) warnings.push(`PNG 高度 ${pngHeight}px，低于参考目标。`);
    if (pngHeight > config.render.targetHeightMax) warnings.push(`PNG 高度 ${pngHeight}px，高于参考目标。`);
    if (pngHeight > config.render.warningHeight) warnings.push("PNG 超过 16000px，应检查是否混入深度版细节。");
    if (mobilePngHeight < mobilePngConfig.targetHeightMin) {
      warnings.push(`手机 PNG 高度 ${mobilePngHeight}px，低于参考目标。`);
    }
    if (mobilePngHeight > mobilePngConfig.targetHeightMax) {
      warnings.push(`手机 PNG 高度 ${mobilePngHeight}px，高于参考目标。`);
    }
    if (mobilePngHeight > mobilePngConfig.warningHeight) {
      warnings.push(`手机 PNG 超过 ${mobilePngConfig.warningHeight}px，应重点检查内容分层。`);
      if (!mobilePngSegments.length) errors.push("手机长图超过分段阈值，但没有生成分段分享图。");
    }

    for (const segment of mobilePngSegments) {
      if (segment.width !== mobilePngConfig.pngWidth) errors.push(`${segment.path} 宽度 ${segment.width}，期望 ${mobilePngConfig.pngWidth}。`);
      if (segment.height > mobilePngConfig.segmentMaximumHeight + 2) errors.push(`${segment.path} 高度超过分段上限。`);
    }

    const report = {
      schemaVersion: "1.3.0",
      generatedAt: new Date().toISOString(),
      browserPath,
      png: { path: "output/quickread.png", width: pngWidth, height: pngHeight },
      mobilePng: {
        path: "output/quickread-mobile.png",
        width: mobilePngWidth,
        height: mobilePngHeight,
        viewportCssWidth: mobilePngConfig.viewportCssWidth,
        deviceScaleFactor: mobilePngConfig.deviceScaleFactor,
        referenceDisplayCssWidth: mobilePngConfig.referenceDisplayCssWidth,
        effectiveBodyFontCssPx: mobileEffectiveBodyFont,
        segments: mobilePngSegments,
      },
      desktop: desktopLayout,
      mobile: mobileLayout,
      mobileExport: mobilePngLayout,
      errors,
      warnings,
    };
    await writeJson(path.join(caseDir, "work", "render-report.json"), report);
    return { outputPath, mobileOutputPath, report };
  } finally {
    await browser.close();
  }
}

if (isMain(import.meta.url)) {
  try {
    const caseDir = resolveCaseDir(process.argv[2]);
    const { outputPath, mobileOutputPath, report } = await screenshotCase(caseDir);
    for (const warning of report.warnings) console.warn(`WARN  ${warning}`);
    for (const error of report.errors) console.error(`ERROR ${error}`);
    console.log(`已截图：${path.relative(REPO_ROOT, outputPath)} (${report.png.width}×${report.png.height})`);
    console.log(`已截图：${path.relative(REPO_ROOT, mobileOutputPath)} (${report.mobilePng.width}×${report.mobilePng.height})`);
    if (report.errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
