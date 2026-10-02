import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  formatTimestamp,
  parseLegacyTimeline,
  parseSource,
  parseTimestamp,
} from "../scripts/lib.mjs";

async function withTempFile(extension, content, callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "quickread-test-"));
  try {
    const filePath = path.join(directory, `source.${extension}`);
    await fs.writeFile(filePath, content, "utf8");
    await callback(filePath);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("timestamp parsing supports SRT and compact timeline forms", () => {
  assert.equal(parseTimestamp("01:02:03,456"), 3_723_456);
  assert.equal(parseTimestamp("62:03.456"), 3_723_456);
  assert.equal(formatTimestamp(3_723_456), "01:02:03.456");
});

test("SRT parser normalizes tags, whitespace, and cue identifiers", async () => {
  await withTempFile(
    "srt",
    "\uFEFF1\n00:00:01,000 --> 00:00:03,500\n<b>你好</b>   世界\n\n2\n00:00:04,000 --> 00:00:05,000\n第二句\n",
    async (filePath) => {
      const cues = await parseSource(filePath, "srt");
      assert.equal(cues.length, 2);
      assert.equal(cues[0].id, "C000001");
      assert.equal(cues[0].text, "你好 世界");
      assert.equal(cues[1].locator.startMs, 4000);
    },
  );
});

test("VTT parser ignores header and NOTE blocks", async () => {
  await withTempFile(
    "vtt",
    "WEBVTT\n\nNOTE generated file\nignore me\n\ncue-1\n00:00:01.000 --> 00:00:02.000\n有效字幕\n",
    async (filePath) => {
      const cues = await parseSource(filePath, "vtt");
      assert.equal(cues.length, 1);
      assert.equal(cues[0].text, "有效字幕");
    },
  );
});

test("Markdown parser produces heading and paragraph locators", async () => {
  await withTempFile(
    "md",
    "# 标题\n\n第一段。\n\n## 分节\n\n第二段第一行。\n第二段第二行。\n",
    async (filePath) => {
      const units = await parseSource(filePath, "md");
      assert.equal(units.length, 2);
      assert.equal(units[0].locator.heading, "标题");
      assert.equal(units[1].locator.heading, "分节");
      assert.equal(units[1].text, "第二段第一行。 第二段第二行。");
    },
  );
});

test("legacy timeline disambiguates HH:MM when final entry uses HH:MM:SS", () => {
  const markdown = `【3. 按时间线详细总结】\n\n* 00:55-01:00：第一段\n  * 说明\n\n* 01:00-01:05：第二段\n  * 说明\n\n* 02:55-02:59:57：结尾\n  * 说明\n\n【4. 主要观点与论据】`;
  const entries = parseLegacyTimeline(markdown);
  assert.equal(entries[0].startMs, 55 * 60 * 1000);
  assert.equal(entries[1].startMs, 60 * 60 * 1000);
  assert.equal(entries[2].endMs, (2 * 3600 + 59 * 60 + 57) * 1000);
});

test("legacy timeline retains MM:SS for podcast-style minute counts", () => {
  const markdown = `【3. 按时间线详细总结】\n\n* 55:39-60:37：第一段\n  * 说明\n\n* 60:37-65:07：第二段\n  * 说明\n\n【4. 主要观点与论据】`;
  const entries = parseLegacyTimeline(markdown);
  assert.equal(entries[0].startMs, (55 * 60 + 39) * 1000);
  assert.equal(entries[1].endMs, (65 * 60 + 7) * 1000);
});
