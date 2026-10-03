# QuickRead v0.1.0

简体中文 · [English](README.en.md)

作者：**guhou-hvi** · **源码公开、个人非商业使用**

项目仓库：[guhou-hvi/quickread](https://github.com/guhou-hvi/quickread)。使用范围见 [许可说明](docs/license-guide.md) 和 [LICENSE](LICENSE)。

**让获取信息所需的时间更短。** 将字幕、音视频转写稿和文章，整理成按主题阅读、带来源依据、可以定制的图文速读与深度阅读稿。

[快速开始](docs/getting-started.md) · [方法示例](docs/examples.md) · [个性化指南](docs/customization.md) · [技术流程](docs/workflow.md)

## 先看成品节选

下面来自随包的[原创演示文章](examples/reading-experiment.md)，由 AI 协助起草，用于验证整理与导出流程。其速读成品**预计阅读 3 分钟**，按每分钟 450 字估算；这是阅读成品所需的时间，不是处理耗时或节时效果实验。

<img src="docs/assets/method-formats.png" alt="原创演示成品节选：图文速读呈现主线，深度阅读稿展开理由" width="700">

这个模块用比较卡说明两种阅读成品各自的任务，并保留段落回查入口。[方法示例](docs/examples.md)还展示如何从判断回到原文。人物背景、概念解释和 QR-Pilot 编辑卡可随材料提供，本演示未包含这些模块。公开包不附完整第三方案例，使用范围见 [素材与版权说明](docs/content-use.md)。

## 为什么做这个项目

看到一场想看的高质量专访或长播客，再看到动辄几小时的时长，我常常先收藏，之后迟迟没有打开。

阅读，不只在书本里。把长谈变成文字，零碎时间也能开始：扫读抓重点，跳读找答案，随时回查。我希望用更少时间抓住长视频的关键信息，再决定哪些部分值得深入。

QuickRead 把按时间展开的对话整理成主题，把重要观点、推理和边界放到一起。发言者的判断保留归属，补充背景单独注明出处，读者可以继续核对来源。

项目由对话驱动：你提供本地材料，Agent 按仓库规则完成分阶段处理、核验和独立审查，输出本地阅读文件。这里的 AI 阅读小编叫 **QR-Pilot**。

## 一份材料，两种阅读成品

| 产物 | 用途 | 形式 |
| --- | --- | --- |
| 图文速读 | 快速了解主题与关键判断 | 响应式 HTML、手机长图、桌面长图 |
| 深度阅读稿 | 连贯阅读推理、背景和重要边界 | Markdown |

需要核对时，还有证据册与结构化来源索引作为辅助。QR-Pilot 在速读中的编辑点评与嘉宾观点分开；并非每份速读都包含点评。深度稿使用第三人称观察者叙述，不含 QR-Pilot 编辑卡。人物背景、关键概念和来源信息随内容提供。

## 快速开始

当前实现路径：**Windows + Node.js ≥24 + Edge/Chrome**。使用能读写文件、运行命令、检索资料并执行独立多角色审查的 AI Agent。

克隆项目并安装依赖：

```powershell
git clone https://github.com/guhou-hvi/quickread.git
cd quickread
node --version
npm ci
```

也可以从 [v0.1.0 Release](https://github.com/guhou-hvi/quickread/releases/tag/v0.1.0) 下载源码 ZIP，解压到新目录后执行 `npm ci`。

在 Agent 中打开项目目录，放一份 `SRT`、`VTT`、`TXT` 或 `MD` 到 `inbox/`，然后说：

```text
处理 inbox，来源链接为 <原始页面链接>。
```

手头有字幕，就导出字幕；有音视频，就先用语音转写工具生成文字；已有文章，则保存 TXT／MD。Bilibili Obsidian Clipper、YouTube 文字稿和 Buzz 都是可选择的外部准备方式，工具不限定。转写后抽查人名、数字、专有名词和说话人；有时间定位时优先 SRT／VTT。详见 [材料准备与转写](docs/getting-started.md#准备字幕或正文)。

QuickRead 当前接收本地 `SRT/VTT/TXT/MD`，音视频获取与转写在项目外完成。先了解关键信息，再决定哪些部分值得细读。

来源链接用于回源与核验。详细环境、外部文件用法和交付位置见 [快速开始](docs/getting-started.md)。

也可以先对 Agent 说：`处理 examples/reading-experiment.md；这是原创演示材料，没有公开来源链接。` 它用于验证本地处理与导出流程，不是节时效果实验。新目录中的第一个案例从 `QR-0001` 开始。

## 改成适合自己的版本

你可以让 Agent 调整关注点、详略和版式。例如：

> 我更关心产品决策，请突出目标、约束、选择理由与代价；保留关键限定和来源依据。请用现有提示词与配置，把这个偏好应用到下一个案例。

[个性化指南](docs/customization.md) 提供技术研究、产品商业、阅读预算和视觉样式的具体指令，并列出实际生效的文件入口。

## 已用于不同类型的材料

| 材料 | 阅读时关心什么 |
| --- | --- |
| 季逸超／Manus 访谈 | 产品试错中的判断与选择 |
| Patrick Winston《How to Speak》讲座 | 方法、步骤与练习 |
| 法国经济政策多人辩论 | 同一议题下的观点分歧 |
| 康林松／奔驰专访 | 产业转型中的目标、约束与决策 |

这些是现有成品中的具体案例，不代表对所有内容类型的效果承诺。来源与展示范围见 [方法示例](docs/examples.md)。本地处理后，可在 `cases/README.md` 或 `cases/index.html` 查看自己的案例目录；完整材料不随公开宣传包分发。

## 维护与反馈

[技术流程与维护参考](docs/workflow.md) 保留完整命令、版本及迁移说明；Agent 的执行约定见 [AGENTS.md](AGENTS.md)。[发布说明](docs/publication.md) 介绍 v0.1.0 的内容与使用范围。

使用反馈与额外授权申请统一提交到 [GitHub Issues](https://github.com/guhou-hvi/quickread/issues)。商业、机构使用及站外再分发须另行取得书面授权，提交申请不等于获准。

欢迎从一份自己想读的材料开始使用；觉得有帮助，也欢迎点个 Star。
