import path from "node:path";
import {
  isMain,
  loadCase,
  readJson,
  readJsonLines,
  REPO_ROOT,
  resolveCaseDir,
  sha256File,
  writeJson,
} from "./lib.mjs";
import { automaticProfileDecision, LENSES, PROFILES } from "./workflow-contract.mjs";

const SEEDED_PROFILES = new Map([
  ...["0001", "0003", "0005", "0006", "0007", "0013", "0014", "0016", "0017", "0018", "0019", "0020", "0021"]
    .map((number) => [`QR-${number}`, "knowledge"]),
  ...["0004", "0008", "0009", "0010", "0011", "0012", "0015", "0022", "0024"]
    .map((number) => [`QR-${number}`, "strategy"]),
  ...["0002", "0023"].map((number) => [`QR-${number}`, "narrative"]),
]);

const PROFILE_TERMS = {
  knowledge: ["研究", "模型", "数学", "原理", "机制", "证明", "训练", "数据", "论文", "技术", "开源", "实验", "学术", "算法"],
  strategy: ["战略", "公司", "组织", "商业", "产品", "市场", "决策", "竞争", "增长", "管理", "创业", "融资", "上市", "转型"],
  narrative: ["经历", "故事", "历史", "当时", "后来", "转折", "成长", "回忆", "生涯", "漂流", "进化史"],
  debate: ["争论", "反对", "同意", "分歧", "辩论", "质疑", "反驳", "立场", "是否", "为什么"],
  general: ["访谈", "对话", "观点", "问题", "观察"],
};

const LENS_TERMS = {
  research: ["研究", "论文", "实验", "学术", "模型训练"],
  product: ["产品", "用户", "体验", "应用"],
  startup: ["创业", "创始人", "融资", "公司"],
  organization: ["组织", "管理", "招聘", "团队", "CEO"],
  career: ["生涯", "成长", "求学", "职业", "经历"],
  history: ["历史", "进化史", "回顾", "诞生"],
  industry: ["产业", "行业", "市场", "供应链"],
  policy: ["政策", "监管", "制度"],
  "open-source": ["开源", "社区", "GitHub", "vLLM", "SGLang"],
  education: ["教育", "学习", "学校", "学生", "课程"],
};

function uniformSample(units, count = 32) {
  if (units.length <= count) return units;
  const indexes = new Set();
  for (let index = 0; index < count; index += 1) {
    indexes.add(Math.round(index * (units.length - 1) / (count - 1)));
  }
  return [...indexes].sort((a, b) => a - b).map((index) => units[index]);
}

function termHits(text, terms) {
  return terms.reduce((count, term) => count + (text.toLocaleLowerCase("zh-CN").includes(term.toLocaleLowerCase("zh-CN")) ? 1 : 0), 0);
}

export function scoreProfiles(manifest, units) {
  const sample = uniformSample(units);
  const metadata = [manifest.title, manifest.shortTitle, ...(manifest.tags ?? []), ...(manifest.participants ?? [])].join(" ");
  const body = sample.map((unit) => unit.text).join(" ");
  const raw = {};
  for (const profile of PROFILES) {
    const terms = PROFILE_TERMS[profile];
    raw[profile] = 2.5 * termHits(metadata, terms) + termHits(body, terms);
  }
  const maximum = Math.max(1, ...Object.values(raw));
  const scores = Object.fromEntries(PROFILES.map((profile) => {
    const relative = raw[profile] / maximum;
    const score = 0.2 + relative * 0.75;
    return [profile, Math.round(Math.min(0.95, score) * 1000) / 1000];
  }));
  return { scores, sampleSourceIds: sample.map((unit) => unit.id) };
}

export function inferLenses(manifest, units) {
  const sample = uniformSample(units, 20);
  const text = [manifest.title, manifest.shortTitle, ...(manifest.tags ?? []), ...sample.map((unit) => unit.text)].join(" ");
  return Object.entries(LENS_TERMS)
    .map(([lens, terms]) => [lens, termHits(text, terms)])
    .filter(([, score]) => score > 0)
    .sort((first, second) => second[1] - first[1] || LENSES.indexOf(first[0]) - LENSES.indexOf(second[0]))
    .slice(0, 3)
    .map(([lens]) => lens);
}

export async function profileCase(caseDir, { confirmedProfile = null, useSeed = false, assessmentPath = null } = {}) {
  const { manifest, manifestPath, sourcePath } = await loadCase(caseDir);
  const [profileConfig, units] = await Promise.all([
    readJson(path.join(REPO_ROOT, "config", "profiles.json")),
    readJsonLines(path.join(caseDir, "work", "source.normalized.jsonl")),
  ]);
  let { scores, sampleSourceIds } = scoreProfiles(manifest, units);
  let assessment = null;
  if (assessmentPath) {
    assessment = await readJson(path.resolve(caseDir, assessmentPath));
    if (!assessment.assessedBy || !assessment.rationale || assessment.sourceSha256 !== manifest.source.sha256 || assessment.sourceSha256 !== await sha256File(sourcePath)) throw new Error('Profile 语义评分缺少审阅依据或源文件哈希已失效。');
    for (const name of PROFILES) if (!Number.isFinite(assessment.scores?.[name]) || assessment.scores[name] < 0 || assessment.scores[name] > 1) throw new Error(`无效的 Profile 评分：${name}`);
    scores = Object.fromEntries(PROFILES.map(name => [name, assessment.scores[name]]));
    sampleSourceIds = units.map(unit => unit.id);
  }
  const decision = automaticProfileDecision(scores, profileConfig.automaticSelection);
  const seeded = useSeed ? SEEDED_PROFILES.get(manifest.caseNumber) : null;
  if (confirmedProfile && !PROFILES.includes(confirmedProfile)) {
    throw new Error(`未知 profile：${confirmedProfile}`);
  }
  const primary = confirmedProfile ?? seeded ?? decision.primary;
  const selection = confirmedProfile ? "confirmed" : seeded ? "seeded" : primary ? "auto" : "pending";
  const confidence = seeded ? 1 : confirmedProfile ? 1 : decision.topScore;
  const lenses = inferLenses(manifest, units);
  manifest.profile = {
    primary,
    lenses,
    selection,
    confidence,
    version: profileConfig.version,
  };
  await writeJson(manifestPath, manifest);
  const result = {
    schemaVersion: "1.0.0",
    caseId: manifest.id,
    selectedAt: new Date().toISOString(),
    selection,
    selectedProfile: primary,
    confidence,
    scores,
    topProfile: decision.topProfile,
    runnerUp: decision.runnerUp,
    lead: decision.lead,
    thresholds: profileConfig.automaticSelection,
    requiresConfirmation: primary === null,
    sampleSourceIds,
    lenses,
    assessment: assessment ? { assessedBy: assessment.assessedBy, sourceSha256: assessment.sourceSha256, rationale: assessment.rationale } : null,
  };
  await writeJson(path.join(caseDir, "work", "profile-selection.json"), result);
  return result;
}

if (isMain(import.meta.url)) {
  try {
    const caseDir = resolveCaseDir(process.argv[2]);
    const confirmationIndex = process.argv.indexOf("--confirm");
    const confirmedProfile = confirmationIndex >= 0 ? process.argv[confirmationIndex + 1] : null;
    const assessmentIndex = process.argv.indexOf("--assessment");
    const assessmentPath = assessmentIndex >= 0 ? process.argv[assessmentIndex + 1] : null;
    if (assessmentIndex >= 0 && !assessmentPath) throw new Error('--assessment 需要评分文件路径。');
    const result = await profileCase(caseDir, { confirmedProfile, assessmentPath });
    if (result.requiresConfirmation) {
      console.error(
        `profile 置信度不足：候选 ${result.topProfile} (${result.confidence})，领先 ${result.lead}。请使用 --confirm <profile> 确认。`,
      );
      process.exitCode = 2;
    } else {
      console.log(`已选择 ${result.selectedProfile}（${result.selection}，置信度 ${result.confidence}）。`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export { SEEDED_PROFILES };
