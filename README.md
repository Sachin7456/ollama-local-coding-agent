<!--
  qwen-harness — the private, offline, zero-dependency AI coding agent for local
  Qwen models via Ollama.
  SEO keywords: local LLM agent, offline AI coding assistant, Ollama, Qwen,
  qwen2.5-coder, qwen3-coder, autonomous coding agent, tool-using LLM, agentic loop,
  ReAct, function calling, multi-agent, zero-dependency, TypeScript, Node.js,
  private AI, on-device AI, self-hosted AI, no API key, terminal CLI agent,
  local inference, code generation, developer tool.
  The banner / typing line / badges are decorative external images (shields.io,
  vercel, demolab) rendered only on GitHub; they do not affect the tool.
-->
<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:1f6feb,100:8957e5&height=190&section=header&text=qwen-harness&fontSize=52&fontColor=ffffff&fontAlignY=38&desc=The%20private%2C%20offline%20AI%20coding%20agent%20for%20local%20Qwen%20models&descSize=16&descAlignY=60" alt="qwen-harness" />

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&size=22&pause=900&color=8957E5&center=true&vCenter=true&width=680&lines=Private.+Offline.+Zero+dependencies.;A+real+AI+coding+agent+%E2%80%94+not+a+chatbot.;Powered+by+Ollama+%2B+Qwen%2C+on+YOUR+machine.;No+cloud.+No+API+keys.+No+data+leaves." alt="tagline" />

<p>
  <img src="https://img.shields.io/badge/tests-269%20passing-2ea44f" alt="tests" />
  <img src="https://img.shields.io/badge/dependencies-0-2ea44f" alt="zero dependencies" />
  <img src="https://img.shields.io/badge/build-none-2ea44f" alt="no build step" />
  <img src="https://img.shields.io/badge/runs-100%25%20offline-6e40c9" alt="offline" />
  <img src="https://img.shields.io/badge/license-Apache_2.0-blue" alt="license Apache-2.0" />
  <img src="https://img.shields.io/badge/Ollama-Qwen-000000?logo=ollama&logoColor=white" alt="ollama qwen" />
  <img src="https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&logoColor=white" alt="typescript" />
</p>

### Turn a model running on your own machine into a real, tool-using software agent.

No cloud. No API keys. No telemetry. Your code never leaves your computer.

**[📘 Use it](./USER-GUIDE.md)** &nbsp;·&nbsp; **[🧩 How it works](./THIRD_PARTY_NOTICES.md)** &nbsp;·&nbsp; **[🤝 Contribute](./CONTRIBUTING.md)** &nbsp;·&nbsp; **[🙏 Help wanted](./OPEN-PROBLEMS.md)** &nbsp;·&nbsp; **[⚖️ License](./LICENSE)**

</div>

---

## 🧭 Looking for…

| Looking for… | Go to |
|---|---|
| 📘 Install &amp; use it (step by step) | **[USER-GUIDE.md](./USER-GUIDE.md)** |
| 🧩 How it works (architecture &amp; design) | **[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)** |
| 🐳 Run it safely / contained | **[USER-GUIDE.md](./USER-GUIDE.md)** → *Running contained* |
| 🙏 Open problems / help wanted | **[OPEN-PROBLEMS.md](./OPEN-PROBLEMS.md)** |
| 🤝 Contribute | **[CONTRIBUTING.md](./CONTRIBUTING.md)** |
| ⚖️ License (Apache-2.0) | **[LICENSE](./LICENSE)** |

---

## 🌟 Why qwen-harness?

- 🔒 **Truly private & offline.** The model, your files, and every transcript stay on
  your machine. Zero network egress, no accounts, no API keys, no vendor lock-in.
- ⚡ **Zero dependencies, zero build step.** Pure TypeScript run directly by Node —
  clone, point it at Ollama, go. Nothing to install from a registry.
- 🤖 **A real agent, not a chatbot.** It reads, searches, writes, and edits files and
  runs commands in a permission-gated **read → decide → act → observe** loop —
  including **multi-agent** delegation, **long-term memory**, and **resumable sessions**.
- 🛡️ **Safe by default.** Every action passes a permission gate, **file tools are confined to your
  workspace** (symlink-proof), and the most dangerous commands are blocked. For full isolation, run it
  inside Docker/WSL or set a sandbox wrapper.
- 🪶 **Built for small local models.** Argument validation + repair, malformed
  tool-call recovery, and automatic context compaction make modest models reliable.
- ✅ **Battle-tested.** 269 automated tests, plus a mandatory secret scan on every run.

## ✨ What it can do

🧩 Use real tools (`read` · `find-files` · `grep` · `write` · `edit` · `multi-edit` · `bash` · `powershell`) &nbsp;•&nbsp;
⚡ run independent **tool calls in parallel** &nbsp;•&nbsp;
👥 split work across **2 parallel agents** &nbsp;•&nbsp;
🧠 **remember** facts across chats &nbsp;•&nbsp;
💾 **resume** any conversation &nbsp;•&nbsp;
🌊 **stream** answers live &nbsp;•&nbsp;
🔁 switch models on the fly &nbsp;•&nbsp;
🛑 **cancel** a running task with Ctrl+C &nbsp;•&nbsp;
🪶 auto-compact long chats.

## 🎯 Built for

Developers who want a **private, air-gapped coding agent** · teams avoiding cloud AI
costs and data exposure · anyone running **local LLMs** who wants real *actions*, not
just chat · learners who want a clean, readable **agent architecture** to study.

## 📖 Documentation

This README is the front door. Everything else lives in a focused document:

| Looking for… | Go to |
|---|---|
| **Install, run & use it** — step-by-step, plain-English | **[USER-GUIDE.md](./USER-GUIDE.md)** |
| **Architecture + data-flow diagram, project structure, technology choices, dependencies** | **[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)** |
| **Contributing & the dev/test workflow** | **[CONTRIBUTING.md](./CONTRIBUTING.md)** |
| **License (Apache-2.0)** | **[LICENSE](./LICENSE)** |

## 🚀 Try it in 60 seconds

```bash
ollama serve     # start your local model server
npm start        # launch the agent (interactive)
```

Then just type what you want in plain English. Full walkthrough, options, and
examples → **[USER-GUIDE.md](./USER-GUIDE.md)**.

## 💡 Using it to the fullest

The small things that make it genuinely useful day to day:

**🗣️ It holds the whole conversation.** In the interactive REPL the agent remembers
everything said so far, so follow-ups just work:
```text
> Read config.ts and tell me what it does.
> Now add a comment at the top explaining that.   ← it knows "that" = config.ts
```

**⏸️ Stop now, continue later — right where you left off.** Every chat is saved and the
REPL prints a session id at startup:
```bash
npm start -- --list-sessions       # find a past chat
npm start -- --resume <id>         # reopen it with full context restored
# inside the REPL:  /sessions  (list)    /new  (start fresh)
```

**🧠 It remembers across different chats.** Tell it something durable and it comes back
later, even in a brand-new conversation:
```text
> Remember that our build output goes in the dist folder.
# …a new chat, another day:
> Where does the build output go?        →  "the dist folder"
```

**👥 Hand a big job to a team (max 2 at once).**
```bash
npm start -- --multi "add a header comment to every file in src, in parallel"
```

**🔁 Switch brains for the task** — fast 7B for everyday work, the bigger model for hard
problems, mid-chat:
```text
/model qwen3-coder:30b        (/model qwen2.5-coder:7b to switch back)
```

**🎚️ Decide how often it checks with you:**
```text
/mode acceptEdits   # stop confirming each edit (dangerous commands still blocked)
/mode plan          # look only, change nothing
/mode default       # ask before every change (the safe default)
```

**⚡ One-and-done for a quick task:**
```bash
npm start -- "list the files here and tell me which is largest"
```

**⌨️ REPL commands:** `/model <tag>` · `/mode <mode>` · `/models` · `/sessions` · `/new` · `/exit`

> Prefer a full, step-by-step walkthrough? → **[USER-GUIDE.md](./USER-GUIDE.md)**.

## ⭐ At a glance

**269 tests · 0 dependencies · no build step · 100% offline · Apache-2.0 licensed.**

## 🙏 Help wanted

A few hard problems are still open — reliable tool-calls on small models, blocking destructive commands without
a sandbox, prompt-injection resistance, and more. Each is documented with a **reproducible proof** and a stable
ID (`Help001`, `Help002`, …) in **[OPEN-PROBLEMS.md](./OPEN-PROBLEMS.md)**.

> 🐳 **Running in Docker/WSL already neutralises or contains 4 of the 7** (the safety ones) — the rest are
> model-quality questions. Ideas, references, and PRs are very welcome: open an issue titled `[HelpNNN] …`.

## 🔎 Keywords

`local LLM agent` · `offline AI coding assistant` · `Ollama` · `Qwen` ·
`qwen2.5-coder` · `qwen3-coder` · `autonomous coding agent` · `tool-using LLM` ·
`agentic loop` · `ReAct` · `function calling` · `multi-agent` · `zero-dependency` ·
`TypeScript` · `Node.js` · `private AI` · `on-device AI` · `self-hosted AI` ·
`no API key` · `terminal / CLI AI` · `local inference` · `code generation` ·
`developer tool`

<sub>💡 For real discoverability, also set these as the repository **Description** and
**Topics** in GitHub's “About” panel — that, plus this README, is what search engines
and GitHub search index.</sub>

<div align="center"><sub>Apache-2.0 Licensed · Designed to run entirely on your machine 🖥️</sub></div>
