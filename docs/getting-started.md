# 开始使用 QuickRead

在项目目录中与 Agent 对话，让 AI 阅读小编 QR-Pilot 把本地字幕、音视频转写稿或文章整理成图文速读和深度阅读稿。证据册与来源索引作为核对时的辅助。

## 运行条件

当前实现使用 Windows 上的 Node.js **24 或更新版本**，截图脚本会查找以下浏览器安装位置：

- `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
- `C:\Program Files\Microsoft\Edge\Application\msedge.exe`
- `C:\Program Files\Google\Chrome\Application\chrome.exe`

项目安装 `playwright-core`，直接调用已有浏览器。内容处理由你正在使用的 Agent 执行：它需要能读取仓库规则、修改文件、运行命令、检索资料，并以独立上下文完成多角色审查。模型使用和相关费用由所用 Agent 环境承担。

项目接收本地 `SRT`、`VTT`、`TXT`、`MD`。字幕、音视频和文章先准备成这些文字文件，再进入同一整理流程。来源链接用于回源和核验；音视频获取与语音转写由外部工具完成。

## 1. 获取项目并安装依赖

项目仓库为 [guhou-hvi/quickread](https://github.com/guhou-hvi/quickread)，使用范围见 [个人非商业许可说明](license-guide.md)。可以用 Git 克隆，或下载源码 ZIP。

已安装 Git 时，在 PowerShell 中执行：

```powershell
git clone https://github.com/guhou-hvi/quickread.git
cd quickread
node --version
npm ci
```

不使用 Git 时，从 [v0.1.0 Release](https://github.com/guhou-hvi/quickread/releases/tag/v0.1.0) 下载附带的源码 ZIP，解压到新目录。在该目录打开 PowerShell，先用 `node --version` 确认版本，再执行 `npm ci`。Release 同时提供包的 SHA-256，便于核对下载文件。

在 Agent 中打开这个目录，让它读取 [AGENTS.md](../AGENTS.md)。

首次试跑可以直接使用随包附带的原创文章：

```text
处理 examples/reading-experiment.md；这是原创演示材料，没有公开来源链接。
```

Agent 会复制原文到新案例，保留原文件，并继续生成深度阅读稿、图文速读及长图。该材料只验证流程，不提供阅读提效的实验结论。代码命令负责解析、校验与渲染，内容整理和独立审查仍由 Agent 完成。

## 准备字幕或正文

根据手头的材料选择一条路径：

| 手头材料 | 外部准备步骤 | 交给 QuickRead 的文件 |
| --- | --- | --- |
| 已有字幕 | 导出字幕，或复制平台文字稿 | SRT / VTT / TXT |
| 已有音频或视频 | 用语音转写工具生成文字并抽查 | SRT / VTT / TXT |
| 已有文章或文字稿 | 保存正文，保留标题与段落 | TXT / MD |

有时间定位时优先保留 SRT/VTT；只有正文时使用 TXT/MD，不需要编造时间戳。正文请保存为 UTF-8 编码。把文件改成 `.srt` 后缀不会自动生成时间信息。

使用自己有权处理的材料。取得字幕不等于取得公开传播许可，个人本地阅读与对外发布需要分别判断，见 [素材与版权说明](content-use.md)。

### B 站：Bilibili Obsidian Clipper

这是我目前使用的浏览器扩展。可以直接从 [Chrome 扩展商店](https://chromewebstore.google.com/detail/bilibili-obsidian-clipper/jokophbofiphenlplmohabdcmalcbenl?hl=zh-CN)或 [Edge 扩展商店](https://microsoftedge.microsoft.com/addons/detail/fbeeapnjdjgacilaobonekidbfjcmdjo)安装。

1. 打开想处理的视频的普通播放页，确认播放器提供字幕轨。
2. 点击扩展图标，预览字幕；多条字幕轨时选择需要的一条。
3. 下载 SRT 或 TXT，再把文件放入本项目的 inbox。

扩展也可以复制 Markdown。直接下载字幕不需要配置 Obsidian；只有想把内容写入 Obsidian 时才需要其 Local REST API。它读取已有的作者字幕或平台 AI 字幕轨，没有字幕轨的视频需要另行转写。[官方功能与操作说明](https://github.com/haixiong1997/Bilibili-Obsidian-Clipper)

### YouTube：平台文字稿

对于已有字幕的视频，在视频说明中打开“显示文字稿”（Show transcript），查看字幕全文，然后手动复制保存为 UTF-8 编码的 TXT 文件。保留可用的时间信息。不同界面可能显示“转写文稿”等近义名称。

这是查看、复制文字稿的路径，YouTube 官方帮助没有将它描述为直接下载 SRT 的功能。[YouTube 官方帮助](https://support.google.com/youtube/answer/15930243?hl=zh-Hans)

### 音视频：先转写，再整理

文件可以来自自己录制、作者提供或平台允许的下载。取得文件后，可以使用熟悉的语音转写软件；只要能导出上述文字格式，就能交给 QuickRead。下列以 [Buzz 官方项目](https://github.com/chidiwilliams/buzz) 为例，它是独立桌面工具，支持音视频转写及 TXT/SRT/VTT 导出。

1. **安装与首次准备**：从官方项目的 Installation → Windows 入口下载安装包；目前该入口指向 [Buzz 的 SourceForge 下载页](https://sourceforge.net/projects/buzz-captions/files/)。选择本地转写模型时，先联网准备所需模型资源，确认下载完成再处理长文件。模型与后端选择以当前软件界面为准。
2. **导入文件**：在软件中导入音频或视频。先选一段较短、容易回听的材料，确认声音与语言正确，再处理长材料。
3. **设置并转写**：选择原音频的语言和转写选项，需要保留原话时选择转写。启动后等待任务完成；耗时随文件长度、硬件、模型而变。
4. **导出文字**：有时间定位时优先导出 SRT/VTT，便于之后回查；只有正文时导出 TXT。转写稿与平台字幕都能进入相同的文字整理流程。
5. **抽查并保存**：回听开头、中段及包含关键判断的片段，重点核对人名、数字、专有名词、否定词和说话人。无法确认的名字或说话人不要猜填，可另附疑点说明。保留原音视频及一份原始转写稿，再将选定的文字文件放入 inbox。

语音转写可能出错，后续总结不能自动弥补错误原文。QuickRead 仍按来源核验流程整理；输入为 TXT/MD 时使用章节或段落定位。以上工具与步骤属于材料准备，不是 QuickRead 内置的音视频下载或转写功能。

### 博客与文章

把需要阅读的正文保存为 TXT 或 Markdown，并在启动时提供原始页面链接。尽量保留原有标题和段落层级，便于使用章节或段落位置回查。

## 2. 放入一份材料

将字幕或文章放入 [inbox](../inbox/README.md)。首次使用建议只放一份文件，方便 Agent 明确本次任务。

成功接收后，原始内容会归档到案例的 `input/`，并从 inbox 移除该份临时副本。若希望保留外部文件原位置，可以直接在下一步提供外部路径；外部原文件会保留。

## 3. 用对话启动

```text
处理 inbox，来源链接为 <这份材料的原始页面链接>。
```

也可以只说“处理 inbox”。项目会尝试查找来源；无法确认时会在案例中保留待核验状态。

外部路径示例：

```text
处理 D:\materials\interview.srt，来源链接为 <原视频链接>。
```

Agent 会分配 `QR-NNNN` 编号，完成解析、内容整理、资料核验、独立审查、编辑和导出。若材料类型无法可靠选择，可能需要你确认一次类型；成品完成后集中查看和反馈。

处理耗时与原材料长度、模型响应、检索和修订有关。页面上的“预计阅读时间”指成品的阅读时间。

## 查看结果

处理完成后，从本地生成的 `cases/README.md` 进入对应案例，也可以在本地浏览器打开 `cases/index.html` 搜索。公开原创演示节选见 [方法示例](examples.md)。

| 想做什么 | 查看产物 |
| --- | --- |
| 快速了解主题 | `output/quickread.html` |
| 手机阅读 | `output/quickread-mobile.png` |
| 阅读完整论述 | `output/deep-read.md` |
| 核对观点及来源 | `output/evidence-book.md` |
| 桌面长图 | `output/quickread.png` |

长图由本地生成，默认不纳入 Git。手机图过长时，还会生成按内容安全切分的 `quickread-mobile-NN.png`。

先看公开的 [方法与成品节选](examples.md)。自己的完整案例保存在本地 `cases/<案例目录>/output/`：HTML 用浏览器打开，Markdown 用编辑器阅读。若需要公开分享产物，再核查原内容许可及具体展示范围。

## 调整与维护

希望更关注技术、改变详略或换样式，接着看 [个性化指南](customization.md)。需要查具体命令、审查机制或迁移流程，查看 [技术流程与维护参考](workflow.md)。

首次遇到错误时，把命令输出交给 Agent 定位。浏览器找不到时，先确认上述安装位置；新的浏览器路径需要修改截图脚本。没有独立审查能力的 Agent 环境，需要补齐该能力才能完成本仓库的完整流程。
