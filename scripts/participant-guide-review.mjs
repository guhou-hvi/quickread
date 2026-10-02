import fs from "node:fs/promises";
import path from "node:path";

import {
  isMain,
  readJson,
  readJsonLines,
  resolveCaseDir,
  writeJson,
} from "./lib.mjs";
import { renderParticipantGuideMarkdown } from "./participant-guide.mjs";
import { sha256Value } from "./review-contract.mjs";
import { latestCompletedLiteReviewRound } from "./reader-review-v240.mjs";

const REQUIRED_ROLES = Object.freeze(["external_citation", "reader_advocate"]);

function reviewRoot(caseDir) {
  return path.join(caseDir, "work", "reviews", "2.4.0", "participant-guide");
}

function withinRoot(root, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) return false;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relativePath);
  return resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

async function optionalJson(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function guideCitationIds(guide) {
  return new Set([
    ...(guide.principals ?? []).flatMap((entry) => entry.citationRefs ?? []),
    ...(guide.supportingRoles ?? []).flatMap((entry) => entry.citationRefs ?? []),
  ]);
}

function citedResearchOnly(guide, research) {
  const ids = guideCitationIds(guide);
  return (research.citations ?? [])
    .filter((citation) => ids.has(citation.id))
    .toSorted((left, right) => String(left.id).localeCompare(String(right.id)));
}

function renderedGuideContext(deepRead, guide) {
  const placements = [];
  for (const [sectionIndex, section] of (deepRead.sections ?? []).entries()) {
    for (const [moduleIndex, module] of (section.modules ?? []).entries()) {
      for (const [blockIndex, block] of (module.blocks ?? []).entries()) {
        if (block.type !== "participant_guide") continue;
        placements.push({
          sectionIndex,
          sectionTitle: section.title ?? null,
          moduleIndex,
          moduleTitle: module.title ?? null,
          profileModule: module.profileModule ?? null,
          blockIndex,
          blockId: block.id,
        });
      }
    }
  }
  return {
    placements,
    renderedMarkdown: renderParticipantGuideMarkdown(guide),
  };
}

async function participantGuideRoleInputs(caseDir) {
  const workDir = path.join(caseDir, "work");
  const outputDir = path.join(caseDir, "output");
  const [guide, research, deepRead] = await Promise.all([
    readJson(path.join(workDir, "participant-guide.json")),
    readJson(path.join(workDir, "research.json")),
    readJson(path.join(outputDir, "deep-read.json")),
  ]);
  const citations = citedResearchOnly(guide, research);
  const readerContext = renderedGuideContext(deepRead, guide);
  return {
    external_citation: {
      payload: { participantGuide: guide, citations },
      inputHashes: {
        participantGuide: sha256Value(guide),
        citedResearch: sha256Value(citations),
      },
    },
    reader_advocate: {
      payload: { participantGuide: guide, renderedGuideContext: readerContext },
      inputHashes: {
        participantGuide: sha256Value(guide),
        renderedGuideContext: sha256Value(readerContext),
      },
    },
  };
}

export async function participantGuideReviewRoleInputHashes(caseDir) {
  const inputs = await participantGuideRoleInputs(caseDir);
  return Object.fromEntries(REQUIRED_ROLES.map((role) => [role, inputs[role].inputHashes]));
}

function payloadInputHashes(role, payload) {
  if (role === "external_citation") {
    return {
      participantGuide: sha256Value(payload?.participantGuide),
      citedResearch: sha256Value(payload?.citations ?? []),
    };
  }
  if (role === "reader_advocate" && payload?.renderedGuideContext) {
    return {
      participantGuide: sha256Value(payload.participantGuide),
      renderedGuideContext: sha256Value(payload.renderedGuideContext),
    };
  }
  return null;
}

function hashesMatch(actual, expected) {
  return sha256Value(actual) === sha256Value(expected);
}

async function reusableRoleEntry(root, priorManifest, role, currentInputHashes) {
  const entry = (priorManifest?.packets ?? []).find((candidate) => candidate.role === role);
  if (!entry || !withinRoot(root, entry.packetPath) || !withinRoot(root, entry.outputPath)) return null;
  const [packet, report] = await Promise.all([
    optionalJson(path.join(root, entry.packetPath)),
    optionalJson(path.join(root, entry.outputPath)),
  ]);
  if (!packet || !report || sha256Value(packet) !== entry.packetHash || packet.packetId !== entry.packetId) return null;
  if (report.role !== role || report.reviewerId !== entry.reviewerId || report.packetId !== entry.packetId) return null;
  if (report.packetHash && report.packetHash !== entry.packetHash) return null;
  const packetHashes = payloadInputHashes(role, packet.payload);
  if (!packetHashes || !hashesMatch(packetHashes, currentInputHashes)) return null;
  return {
    ...entry,
    inputHashes: currentInputHashes,
    retainedReport: {
      mode: "verified_packet_payload",
      reportHash: sha256Value(report),
    },
  };
}

export async function prepareParticipantGuideReview(caseDir, assignments = {}) {
  const root = reviewRoot(caseDir);
  const [manifest, roleInputs, priorManifest] = await Promise.all([
    readJson(path.join(caseDir, "case.json")),
    participantGuideRoleInputs(caseDir),
    optionalJson(path.join(root, "manifest.json")),
  ]);
  const priorIds = Object.fromEntries((priorManifest?.packets ?? []).map((entry) => [entry.role, entry.reviewerId]));
  const ids = Object.fromEntries(REQUIRED_ROLES.map((role) => [role, String(assignments[role] ?? priorIds[role] ?? "").trim()]));
  if (REQUIRED_ROLES.some((role) => !ids[role]) || new Set(Object.values(ids)).size !== REQUIRED_ROLES.length) {
    throw new Error("人物导览审核必须为 external_citation 与 reader_advocate 分配不同 reviewerId；已有未变角色可省略 assignment 以复用其报告。");
  }
  const packets = [];
  for (const role of REQUIRED_ROLES) {
    if (!Object.hasOwn(assignments, role)) {
      const retained = await reusableRoleEntry(root, priorManifest, role, roleInputs[role].inputHashes);
      if (retained) {
        packets.push(retained);
        continue;
      }
    }
    const suffix = sha256Value({ role, reviewerId: ids[role], inputHashes: roleInputs[role].inputHashes }).slice(0, 12);
    const outputPath = `reports/${role}-${suffix}.json`;
    const packetPath = `packets/${role}-${suffix}.json`;
    const packetBase = {
      schemaVersion: "1.1.0",
      caseId: manifest.id,
      reviewPolicyVersion: "2.4.0",
      role,
      assignedReviewerId: ids[role],
      inputHashes: roleInputs[role].inputHashes,
      outputPath,
      instructions: role === "external_citation"
        ? "核验人物在事件时的身份、机构与相关经历；每项事实必须由 packet 中引用或其官方页面支持。不要评价人物、政策或胜负。"
        : "只检查人物导览是否足够简洁、是否帮助理解正文、是否抢占主题内容；普通篇幅偏好只能作为 warning。",
      outputContract: {
        requiredFields: ["schemaVersion", "caseId", "reviewPolicyVersion", "role", "reviewerId", "packetId", "inputHashes", "status", "hardErrors", "warnings", "summary"],
        status: "pass | fail",
        findings: "hardErrors/warnings are arrays of concise strings",
      },
      payload: roleInputs[role].payload,
    };
    const packetId = sha256Value(packetBase);
    const packet = { ...packetBase, packetId };
    const packetHash = sha256Value(packet);
    await writeJson(path.join(root, packetPath), packet);
    packets.push({ role, reviewerId: ids[role], packetPath, outputPath, packetId, packetHash, inputHashes: roleInputs[role].inputHashes });
  }
  const reviewManifest = {
    schemaVersion: "1.1.0",
    caseId: manifest.id,
    reviewPolicyVersion: "2.4.0",
    roleInputHashes: Object.fromEntries(REQUIRED_ROLES.map((role) => [role, roleInputs[role].inputHashes])),
    packets,
  };
  await writeJson(path.join(root, "manifest.json"), reviewManifest);
  return { root, manifest: reviewManifest };
}

export async function participantGuideReviewerReportErrors(caseDir) {
  const root = reviewRoot(caseDir);
  const manifest = await readJson(path.join(root, "manifest.json"));
  const legacy = manifest.schemaVersion === "1.0.0";
  const currentHashes = legacy
    ? await participantGuideReviewInputHashes(caseDir, { includeBrief: false })
    : await participantGuideReviewRoleInputHashes(caseDir);
  const errors = [];
  const reports = [];
  if (legacy) {
    for (const [key, expected] of Object.entries(currentHashes)) if (manifest.inputHashes?.[key] !== expected) errors.push(`人物导览审核 ${key} 已过期。`);
  } else {
    for (const role of REQUIRED_ROLES) {
      if (!hashesMatch(manifest.roleInputHashes?.[role], currentHashes[role])) errors.push(`人物导览审核 ${role} 局部输入已过期。`);
    }
  }
  const ids = new Set();
  for (const entry of manifest.packets ?? []) {
    if (!withinRoot(root, entry.packetPath) || !withinRoot(root, entry.outputPath)) {
      errors.push(`${entry.role} packet/report 路径越界。`);
      continue;
    }
    const packet = await readJson(path.join(root, entry.packetPath));
    if (sha256Value(packet) !== entry.packetHash || packet.packetId !== entry.packetId) errors.push(`${entry.role} packet 哈希已过期。`);
    const report = await readJson(path.join(root, entry.outputPath));
    reports.push(report);
    if (report.role !== entry.role || report.reviewerId !== entry.reviewerId) errors.push(`${entry.role} 报告身份与 assignment 不一致。`);
    if (report.packetId !== entry.packetId || (report.packetHash && report.packetHash !== entry.packetHash)) errors.push(`${entry.role} 报告未绑定 packet。`);
    if (legacy) {
      if (!hashesMatch(report.inputHashes, currentHashes)) errors.push(`${entry.role} 报告输入哈希已过期。`);
    } else {
      const expected = currentHashes[entry.role];
      if (!hashesMatch(entry.inputHashes, expected)) errors.push(`${entry.role} manifest 局部输入哈希已过期。`);
      if (entry.retainedReport) {
        if (entry.retainedReport.mode !== "verified_packet_payload" || entry.retainedReport.reportHash !== sha256Value(report)) {
          errors.push(`${entry.role} 复用报告绑定无效。`);
        }
        const payloadHashes = payloadInputHashes(entry.role, packet.payload);
        if (!payloadHashes || !hashesMatch(payloadHashes, expected)) errors.push(`${entry.role} 旧 packet 实际输入已过期。`);
      } else if (!hashesMatch(report.inputHashes, expected)) {
        errors.push(`${entry.role} 报告局部输入哈希已过期。`);
      }
    }
    if (!['pass', 'fail'].includes(report.status)) errors.push(`${entry.role} status 非法。`);
    if (!Array.isArray(report.hardErrors) || !Array.isArray(report.warnings) || !String(report.summary ?? '').trim()) errors.push(`${entry.role} 报告结构不完整。`);
    if (ids.has(report.reviewerId)) errors.push("人物导览审核 reviewerId 必须相互独立。");
    ids.add(report.reviewerId);
  }
  for (const role of REQUIRED_ROLES) if (!reports.some((report) => report.role === role)) errors.push(`人物导览审核缺少 ${role} 报告。`);
  return { errors: [...new Set(errors)], reports, manifest };
}

export async function participantGuideReviewRecordErrors(caseDir, record) {
  const errors = [];
  if (record.schemaVersion === "1.2.0") {
    const current = await participantGuideReviewRoleInputHashes(caseDir);
    for (const role of REQUIRED_ROLES) {
      if (!hashesMatch(record.roleInputHashes?.[role], current[role])) errors.push(`人物导览增量审核 ${role} 局部哈希已过期。`);
    }
    return errors;
  }
  const current = await participantGuideReviewInputHashes(caseDir, { includeBrief: record.schemaVersion === "1.0.0" });
  for (const [key, value] of Object.entries(current)) if (record.inputHashes?.[key] !== value) errors.push(`人物导览增量审核 ${key} 已过期。`);
  return errors;
}

export async function participantGuideReviewInputHashes(caseDir, { includeBrief = false } = {}) {
  const workDir = path.join(caseDir, "work");
  const outputDir = path.join(caseDir, "output");
  const [claims, participantGuide, research, deepRead, readerMarkdown] = await Promise.all([
    readJsonLines(path.join(workDir, "evidence.jsonl")),
    readJson(path.join(workDir, "participant-guide.json")),
    readJson(path.join(workDir, "research.json")),
    readJson(path.join(outputDir, "deep-read.json")),
    fs.readFile(path.join(outputDir, "deep-read.md"), "utf8"),
  ]);
  const hashes = {
    evidence: sha256Value(claims),
    participantGuide: sha256Value(participantGuide),
    research: sha256Value(research),
    deepRead: sha256Value(deepRead),
    readerMarkdown: sha256Value(readerMarkdown),
  };
  if (includeBrief) hashes.brief = sha256Value(await readJson(path.join(outputDir, "brief.json")));
  return hashes;
}

export function participantGuideReviewDraftErrors(draft) {
  const errors = [];
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(draft?.reviewedAt ?? "")) errors.push("reviewedAt 必须为日期。");
  if (!String(draft?.baselineReview ?? "").trim()) errors.push("缺少 baselineReview。");
  if (!Array.isArray(draft?.reviewers) || draft.reviewers.length !== REQUIRED_ROLES.length) {
    errors.push("人物导览审核必须恰好包含 external_citation 与 reader_advocate 两名审核者。");
    return errors;
  }
  const roles = draft.reviewers.map((reviewer) => reviewer.role);
  const reviewerIds = draft.reviewers.map((reviewer) => reviewer.reviewerId);
  for (const role of REQUIRED_ROLES) if (!roles.includes(role)) errors.push(`缺少 ${role} 审核者。`);
  if (new Set(roles).size !== roles.length) errors.push("审核角色重复。");
  if (new Set(reviewerIds).size !== reviewerIds.length) errors.push("reviewerId 必须相互独立。");
  for (const reviewer of draft.reviewers) {
    if (!String(reviewer.reviewerId ?? "").trim()) errors.push(`${reviewer.role ?? "未知角色"} 缺少 reviewerId。`);
    if (!["pass", "fail"].includes(reviewer.status)) errors.push(`${reviewer.role ?? "未知角色"} status 非法。`);
    if (!Array.isArray(reviewer.hardErrors) || !Array.isArray(reviewer.warnings)) errors.push(`${reviewer.role ?? "未知角色"} 缺少 hardErrors/warnings 数组。`);
  }
  return errors;
}

export async function recordParticipantGuideReview(caseDir) {
  const manifest = await readJson(path.join(caseDir, "case.json"));
  const reviewDir = reviewRoot(caseDir);
  let draft;
  try {
    const checked = await participantGuideReviewerReportErrors(caseDir);
    if (checked.errors.length) throw new Error(checked.errors.join("\n"));
    const liteRound = await latestCompletedLiteReviewRound(caseDir);
    draft = {
      reviewedAt: new Date().toISOString().slice(0, 10),
      baselineReview: `work/reviews/2.4.0/reader-first/round-${String(liteRound).padStart(2, "0")}/consensus.json`,
      reviewers: checked.reports.map(({ role, reviewerId, status, hardErrors, warnings, summary }) => ({ role, reviewerId, status, hardErrors, warnings, summary })),
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    draft = await readJson(path.join(reviewDir, "review-draft.json"));
  }
  const errors = participantGuideReviewDraftErrors(draft);
  if (errors.length) throw new Error(errors.join("\n"));
  const nestedHardErrors = draft.reviewers.flatMap((reviewer) => reviewer.hardErrors ?? []);
  const hardErrors = [...new Set([...(draft.hardErrors ?? []), ...nestedHardErrors])];
  const warnings = [...new Set([...(draft.warnings ?? []), ...draft.reviewers.flatMap((reviewer) => reviewer.warnings ?? [])])];
  const record = {
    $schema: "../../../../../../schemas/participant-guide-review.schema.json",
    schemaVersion: "1.2.0",
    caseId: manifest.id,
    reviewPolicyVersion: "2.4.0",
    reviewedAt: draft.reviewedAt,
    baselineReview: draft.baselineReview,
    roleInputHashes: await participantGuideReviewRoleInputHashes(caseDir),
    reviewers: draft.reviewers,
    hardErrors,
    warnings,
    status: hardErrors.length || draft.reviewers.some((reviewer) => reviewer.status !== "pass") ? "fail" : "pass",
  };
  const outputPath = path.join(reviewDir, "review.json");
  await writeJson(outputPath, record);
  return { outputPath, record };
}

if (isMain(import.meta.url)) {
  try {
    const caseDir = resolveCaseDir(process.argv[2]);
    const result = await recordParticipantGuideReview(caseDir);
    console.log(JSON.stringify({ outputPath: path.relative(process.cwd(), result.outputPath), status: result.record.status }, null, 2));
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}
