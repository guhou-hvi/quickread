# QuickRead

[简体中文](README.md) · English

**Get the key information sooner. Decide what deserves a closer look.**

QuickRead turns local subtitles, audio/video transcripts, and articles into a visual quick read and an in-depth reading document. It organizes long material around themes, keeps the reasons and qualifications behind important judgments, and provides references for checking the source.

Author: **guhou-hvi** · **Source-available for personal noncommercial use**

[Repository](https://github.com/guhou-hvi/quickread) · [Quick start (Chinese)](docs/getting-started.md) · [Examples (Chinese)](docs/examples.md) · [License](LICENSE)

## What you get

| Reading output | What it is for | Files |
| --- | --- | --- |
| Visual quick read | Find the main themes and key judgments | Responsive HTML, mobile and desktop PNGs |
| In-depth reading document | Follow the reasoning, background, and important qualifications | Markdown |

A source and evidence index supports further checking. Speaker views remain attributed; external background is distinguished from the supplied material.

**QR-Pilot** is QuickRead's AI reading editor. An Agent works through the repository's staged workflow to analyze, check, review, and render your material. When editorial notes appear in the quick read, they are separate from speaker views. The in-depth document has no QR-Pilot commentary cards.

The current workflow produces **Simplified Chinese** reading outputs by default. This English introduction does not change the output language or translate the interface, prompts, or detailed documentation.

## See an original demo

These Chinese-language previews come from the included [original demo article](examples/reading-experiment.md), drafted with AI assistance to verify the processing and export workflow. They are not a study of reading efficiency. The screenshots remain in their original language; the captions below explain what they show.

<img src="docs/assets/method-formats.png" alt="Original Chinese demo: a comparison of visual quick reading and in-depth reading, with source references" width="700">

The comparison explains how the two reading outputs serve different needs: an overview first, followed by more detailed reasoning when needed.

<img src="docs/assets/method-traceability.png" alt="Original Chinese demo: a passage linked to its supporting source paragraph" width="700">

Source references let readers return from a statement to the relevant part of the original material. Participant profiles and concept explanations may be added when appropriate; this demo does not illustrate those modules. Full third-party interviews and transcripts are not included in the public repository.

## Try it with one document

Requirements: **Windows, Node.js 24 or newer, and Edge or Chrome**. Your Agent must be able to read and write files, execute commands, retrieve information, and perform independent reviews in separate contexts. Model access and usage costs depend on your Agent environment.

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

The Agent follows the project's processing and review protocol. Results are saved locally under the allocated case's `output/` directory, including `quickread.html`, `quickread-mobile.png`, and `deep-read.md`.

## Prepare the text first

- **Subtitles available:** export them, or copy an available platform transcript into a text file.
- **Audio or video available:** transcribe a file you are entitled to process using an external tool such as [Buzz](https://github.com/chidiwilliams/buzz), then export the text.
- **Article available:** save it as UTF-8 TXT or Markdown, preserving useful headings and its source URL.

Prefer SRT or VTT when timestamps are available. Check names, numbers, technical terms, negations, and speaker attribution after transcription. Media acquisition and speech-to-text happen outside QuickRead; its current inputs are local text files.

Detailed [setup and material preparation](docs/getting-started.md), [customization](docs/customization.md), and [workflow documentation](docs/workflow.md) are available in Chinese. The prompts and configuration can be adjusted locally within the license terms.

## License and feedback

QuickRead is **source-available for personal noncommercial use**, not an OSI-approved open-source project. The [English license](LICENSE) permits individual noncommercial use and private modifications, subject to its terms. Commercial or organizational use and redistribution outside the hosting-platform permissions require separate written permission. Third-party inputs and derived content retain their own rights.

Report first-use problems, share feedback, or request additional permission through [GitHub Issues](https://github.com/guhou-hvi/quickread/issues). A request is not an authorization. If the project helps you, a Star is welcome.
