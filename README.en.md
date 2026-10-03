# QuickRead

[简体中文](README.md) · English

**Get the key information first. Decide what deserves a closer look.**

QuickRead turns local text into two reading outputs: a **visual quick read** and an **in-depth reading document**. Meet **QR-Pilot**, its AI reading editor: an Agent that follows the project's workflow to organize, check, review, and render your material.

[See the demo (Chinese)](docs/examples.md) · [Quick start (Chinese)](docs/getting-started.md) · [Customize it (Chinese)](docs/customization.md)

Author: **guhou-hvi** · **Source-available for personal noncommercial use** · [License](LICENSE)

## 📖 See it in action

These previews come from the included [original demo article](examples/reading-experiment.md), drafted with AI assistance to verify the processing and export workflow. Its quick read takes an estimated **3 minutes**, based on 450 Chinese characters per minute. This estimates reading time, not processing time or measured time savings.

<img src="docs/assets/method-formats.png" alt="Original Chinese demo: a comparison of visual quick reading and in-depth reading, with source references" width="700">

Two ways into the same material: start with the main ideas, then follow the reasoning in more detail when you want to.

<img src="docs/assets/method-traceability.png" alt="Original Chinese demo: a passage linked to its supporting source paragraph" width="700">

Follow a source reference back to the relevant passage. Participant profiles, concept explanations, and QR-Pilot editorial cards can appear when appropriate; this demo illustrates the reading formats and source references.

The current workflow produces **Simplified Chinese** reading outputs by default, as shown in these screenshots. Detailed guides and prompts are also in Chinese. Full third-party interviews and transcripts stay outside the public repository; see [content and copyright notes (Chinese)](docs/content-use.md).

## 🧭 Keep the reasons behind the judgment

I find an interview I'd love to watch, notice the three-hour runtime, and save it for later. Getting back to it is the harder part.

That's why I made QuickRead. Text gives me a way in: skim for the main ideas, jump to a question, or return to a passage. I want to understand the essentials first, then choose where to spend more time.

What I most want to keep is the **why**. What led someone to a conclusion? What conditions does it depend on? How does it connect to the rest of the discussion?

QuickRead organizes material by theme and brings those reasons and qualifications together. Speaker views stay attributed, added background has its own references, and source links let you check the original.

## One document, two reading outputs

| Reading output | What it is for | Files |
| --- | --- | --- |
| Visual quick read | Find the main themes and key judgments | Responsive HTML, mobile and desktop PNGs |
| In-depth reading document | Follow the reasoning, background, and important qualifications | Markdown |

A source and evidence index supports further checking. When QR-Pilot editorial notes appear in the quick read, they are separate from speaker views. The in-depth document uses third-person narration and contains no QR-Pilot commentary cards.

## 🛠️ Start your first read

You'll need **Windows, Node.js 24 or newer, and Edge or Chrome**. Your Agent must be able to read and write files, execute commands, retrieve information, and perform independent reviews in separate contexts.

Model access and usage costs depend on your Agent environment.

Clone the project and install its dependencies:

```powershell
git clone https://github.com/guhou-hvi/quickread.git
cd quickread
node --version
npm ci
```

Alternatively, download the source ZIP attached to the [v0.1.0 Release](https://github.com/guhou-hvi/quickread/releases/tag/v0.1.0), extract it, and run `npm ci` in its root directory. The release archive is the original v0.1.0 snapshot; the repository contains later documentation updates.

1. Open the project in your Agent and have it read `AGENTS.md`.
2. Put **one** local `SRT`, `VTT`, `TXT`, or `MD` file in `inbox/`.
3. Send this exact instruction to the Agent:

```text
处理 inbox
```

This means “process inbox.” Include the original source URL in your message when available. If several files are present, specify which one to process.

You can also begin with the included original demo:

```text
处理 examples/reading-experiment.md；这是原创演示材料，没有公开来源链接。
```

The Agent follows the processing and review protocol, then saves the reading outputs locally under the allocated case's `output/` directory. Start with `quickread.html`, `quickread-mobile.png`, or `deep-read.md`.

## Prepare the text first

- **Subtitles available:** export them, or copy an available platform transcript into a text file.
- **Audio or video available:** transcribe a file you are entitled to process using an external tool such as [Buzz](https://github.com/chidiwilliams/buzz), then export the text.
- **Article available:** save it as UTF-8 TXT or Markdown, preserving useful headings and its source URL.

Prefer SRT or VTT when timestamps are available. Check names, numbers, technical terms, negations, and speaker attribution after transcription. Media acquisition and speech-to-text happen outside QuickRead; its current inputs are local text files.

See [setup and material preparation (Chinese)](docs/getting-started.md) for the detailed steps.

## Make it suit your reading

You can ask your Agent to adjust the focus, level of detail, and visual style. For example:

> I'm most interested in product decisions. Emphasize the goals, constraints, reasons for each choice, and trade-offs, while preserving important qualifications and source references. Use the existing prompts and configuration to apply this preference to the next document.

The [customization guide (Chinese)](docs/customization.md) provides instructions and points to the files that control these choices. The [workflow reference (Chinese)](docs/workflow.md) explains the processing steps and commands.

## License

QuickRead is **source-available for personal noncommercial use**, not an OSI-approved open-source project. The [English license](LICENSE) permits individual noncommercial use and private modifications, subject to its terms. Commercial or organizational use and redistribution outside the hosting-platform permissions require separate written permission. Third-party inputs and derived content retain their own rights.

## 💬 Feedback and conversation

Start with something you've been meaning to read. If setup gets in the way, a passage is hard to follow, or you have an idea for improving the reading experience, tell me through [GitHub Issues](https://github.com/guhou-hvi/quickread/issues).

You can also use Issues to request additional permission; a request is not an authorization. If QuickRead helps you, a Star is welcome.
