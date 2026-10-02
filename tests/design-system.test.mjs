import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { readJson, REPO_ROOT } from "../scripts/lib.mjs";
import { renderBlock, titleMarkHtml } from "../scripts/render.mjs";
import { hierarchyLayoutErrors } from "../scripts/screenshot.mjs";

function rgb(hex) {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
}

function luminance(hex) {
  const channels = rgb(hex).map((channel) => (
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("Clean Scientific tokens are exact and accessible for their intended roles", async () => {
  const tokens = await readJson(path.join(REPO_ROOT, "config", "design-tokens.json"));
  assert.equal(tokens.version, "1.2.0");
  assert.deepEqual(tokens.accent, {
    orange: "#d55e00",
    orangeDark: "#934000",
    orangeSoft: "#fff8f3",
    blue: "#0072b2",
    blueDark: "#005a8d",
    blueSoft: "#f4f9fc",
    yellow: "#c58b00",
    yellowDark: "#765100",
    yellowSoft: "#fffaee",
    green: "#009e73",
    greenDark: "#006a4e",
    greenSoft: "#f3faf7",
    purple: "#7355a6",
    purpleDark: "#523b7a",
    purpleSoft: "#f8f5fb",
  });

  for (const name of ["orangeDark", "blueDark", "yellowDark", "greenDark", "purpleDark"]) {
    assert.ok(contrast(tokens.accent[name], tokens.canvas.paper) >= 4.5, `${name} must pass 4.5:1 on paper`);
  }
  for (const name of ["orange", "blue", "green", "purple"]) {
    assert.ok(contrast(tokens.accent[name], tokens.canvas.paper) >= 3, `${name} must pass 3:1 on paper`);
  }
});

test("scan-lock mark has a deterministic accessible DOM and fading dashed wings", async () => {
  assert.equal(
    titleMarkHtml(),
    '<div class="title-mark" aria-hidden="true"><span class="title-mark-core"></span></div>',
  );

  const css = await fs.readFile(path.join(REPO_ROOT, "templates", "quickread.css"), "utf8");
  assert.match(css, /width:\s*clamp\(220px, 52vw, 420px\)/);
  assert.equal((css.match(/repeating-linear-gradient\(90deg/g) ?? []).length, 2);
  assert.equal((css.match(/mask-image:\s*linear-gradient/g) ?? []).length, 4);
  assert.match(css, /\.title-mark-core\s*\{/);
  assert.match(css, /width:\s*6px;\s*\n\s*height:\s*6px;\s*\n\s*background:\s*var\(--purple\)/);

  const titleMarkBlock = css.match(/\.title-mark\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";
  assert.doesNotMatch(titleMarkBlock, /background\s*:/, "outer marker must not become a continuous rule");
});

test("content marker, data value, and step tag share one primary orange", async () => {
  const css = await fs.readFile(path.join(REPO_ROOT, "templates", "quickread.css"), "utf8");
  for (const selector of ["block-label::before", "stat-value"]) {
    const escaped = selector.replaceAll(".", "\\.").replaceAll(":", "\\:");
    const declarations = css.match(new RegExp(`\\.${escaped}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`))?.groups?.body ?? "";
    assert.match(declarations, /(?:background|color):\s*var\(--orange\)/, `${selector} must use --orange`);
    assert.doesNotMatch(declarations, /var\(--orange-dark\)/, `${selector} must not use --orange-dark`);
  }

  const stepRule = css.match(/\.step-number\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";
  assert.match(stepRule, /border:\s*2px solid var\(--orange\)/);
  assert.match(stepRule, /color:\s*var\(--orange\)/);
  assert.doesNotMatch(stepRule, /border-radius:\s*50%/);
  assert.doesNotMatch(stepRule, /background:\s*var\(--orange\)/);
});

test("section and step numbering differ by shape, fill, and number format", async () => {
  const css = await fs.readFile(path.join(REPO_ROOT, "templates", "quickread.css"), "utf8");
  const sectionRule = css.match(/\.section-number\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";
  const stepRule = css.match(/\.step-number\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";
  assert.match(sectionRule, /border-radius:\s*50%/);
  assert.match(sectionRule, /background:\s*#33383d/);
  assert.match(stepRule, /border-radius:\s*5px/);
  assert.match(stepRule, /background:\s*var\(--orange-soft\)/);

  const html = renderBlock({
    type: "steps",
    provenance: "source_fact",
    items: [{ text: "first" }, { text: "second" }],
  }, new Map());
  assert.match(html, /class="step-number">01<\/div>/);
  assert.match(html, /class="step-number">02<\/div>/);
});

test("local heading bars and list bullets encode hierarchy with different geometry", async () => {
  const css = await fs.readFile(path.join(REPO_ROOT, "templates", "quickread.css"), "utf8");
  const labelRule = css.match(/\.block-label::before\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";
  const bulletRule = css.match(/\.bullet-list li::before\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";
  assert.match(labelRule, /width:\s*3px/);
  assert.match(labelRule, /height:\s*10px/);
  assert.match(labelRule, /border-radius:\s*2px/);
  assert.match(bulletRule, /width:\s*7px/);
  assert.match(bulletRule, /height:\s*7px/);
  assert.match(bulletRule, /border-radius:\s*50%/);
});

test("step alignment CSS and render QA enforce first-line visual centering", async () => {
  const css = await fs.readFile(path.join(REPO_ROOT, "templates", "quickread.css"), "utf8");
  const numberRule = css.match(/\.step-number\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";
  const textRule = css.match(/\.step-text\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";
  const mobileExportRule = css.match(
    /html\[data-export-target="mobile-png"\] \.step-number\s*\{(?<body>[\s\S]*?)\n\}/,
  )?.groups?.body ?? "";
  assert.match(numberRule, /margin-top:\s*1px/);
  assert.match(textRule, /padding-top:\s*0/);
  assert.match(mobileExportRule, /margin-top:\s*4px/);

  const valid = {
    stepAlignment: { missingText: 0, maxFirstLineCenterDelta: 1 },
    hierarchyMarkers: { distinctShape: true },
  };
  assert.deepEqual(hierarchyLayoutErrors("桌面", valid), []);
  assert.match(
    hierarchyLayoutErrors("桌面", {
      stepAlignment: { missingText: 1, maxFirstLineCenterDelta: 1.001 },
      hierarchyMarkers: { distinctShape: false },
    }).join(" "),
    /无法测量.*超过 1px.*相同形态/,
  );
});

test("QR-Pilot identity, action, and subject inherit one heading size", async () => {
  const css = await fs.readFile(path.join(REPO_ROOT, "templates", "quickread.css"), "utf8");
  const prefixRule = css.match(/\.editor-note-name,\s*\n\.editor-note-action\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";
  assert.match(prefixRule, /font-size:\s*inherit/);
  const subjectRule = css.match(/\.editor-note-subject\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";
  assert.doesNotMatch(subjectRule, /font-size\s*:/, "subject must not override the shared heading size");
});

test("mobile PNG export preserves desktop output and provides 15px phone reading size", async () => {
  const pipeline = await readJson(path.join(REPO_ROOT, "config", "pipeline.json"));
  const mobilePng = pipeline.render.mobilePng;

  assert.equal(pipeline.render.pngWidth, 1660, "desktop PNG contract must remain unchanged");
  assert.equal(mobilePng.viewportCssWidth, 480);
  assert.equal(mobilePng.deviceScaleFactor, 2.25);
  assert.equal(mobilePng.pngWidth, 1080);
  assert.equal(mobilePng.rootFontCssPx, 18.5);
  assert.equal(mobilePng.referenceDisplayCssWidth, 390);
  assert.equal(mobilePng.viewportCssWidth * mobilePng.deviceScaleFactor, mobilePng.pngWidth);

  const effectiveBodyFont = mobilePng.rootFontCssPx
    * mobilePng.referenceDisplayCssWidth
    / mobilePng.viewportCssWidth;
  assert.ok(effectiveBodyFont >= 15, `effective body font is ${effectiveBodyFont}px`);

  const css = await fs.readFile(path.join(REPO_ROOT, "templates", "quickread.css"), "utf8");
  assert.match(
    css,
    /html\[data-export-target="mobile-png"\]\s*\{[^}]*font-size:\s*18\.5px/s,
  );
});

test("QuickRead 2.4.2 records the inline context-aware visual template", async () => {
  const pipeline = await readJson(path.join(REPO_ROOT, "config", "pipeline.json"));
  assert.equal(pipeline.workflowVersion, "2.4.2");
  assert.equal(pipeline.templateVersion, "1.4.4");
  assert.equal(pipeline.promptVersion, "3.4.2");
});
