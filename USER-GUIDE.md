# qwen-harness — Plain-English User Guide

*A friendly walkthrough for everyone. No programming background required.*

---

## 1. What is this, in everyday terms?

You have AI models (the **Qwen** family) running **on your own machine** through a
free program called **Ollama**. On their own, those models can only *talk* — they
can answer questions, but they can't open your files or actually do anything for you.

**qwen-harness** is the layer that gives the local AI a safe set of *hands*. With it,
the model can:

- look through, search, create, and edit files on your computer,
- run commands for you (for example, building or testing a project),
- carry out a job in several steps without hand-holding, and
- do all of that **carefully**, checking with you before anything that could change
  your files.

A useful mental picture: a meticulous assistant that lives entirely on your machine,
thinks with your local AI, and **never sends a single byte to the internet**.

---

## 2. What it can do today

- **Explain your files** — "What is this file for?"
- **Search** — "Which files mention the word `invoice`?"
- **Create files** — "Make a file called `notes.txt` that says hello."
- **Edit files carefully** — "Correct the typo in `readme.txt`." It can also make
  several edits to one file in a single all-or-nothing step (the `multi_edit` tool),
  so the file is never left half-changed.
- **Run commands** — "Run the tests and tell me whether they pass." On **Windows** it uses **PowerShell**
  (e.g. `Get-Process` for processes, `Get-ChildItem` to list); on **macOS/Linux** it uses **bash** (`ps`,
  `ls`, …). Safe read-only commands run without asking; anything else asks first.
- **Check your setup** — "Which models do I have installed?" (it can list your local models).
- **Explore a project** — "Read this project and tell me what it does." It uses `find_files` (e.g. `**/*.ts`) and bash to list/find files, then reads the key ones. For a big whole-project job,
  give it more steps: `npm start -- --max-turns 40 "..."`.
- **Handle multi-step jobs** — it reads, plans, acts, checks the result, and keeps
  going until the task is finished. When several steps don't depend on each other
  (such as reading or searching across a few files), it can run them at the same
  time to finish faster.
- **Split big jobs across helpers** — for larger work it can hand pieces to
  **up to two AI helpers working at the same time**.
- **Offer two models** — a **quick** lightweight one and a **stronger** heavier one
  (see section 8).
- **Pick up where you left off** — every conversation is saved, so you can stop now
  and continue another day.
- **Remember useful facts between chats** — tell it something worth keeping and it
  will bring that fact back in later, separate conversations.
- **Keep you in control** — it **asks first** before editing a file or running a
  command, and a built-in floor blocks the most destructive commands (such as wiping
  your drive) — best-effort, not a guarantee (see "Running contained").
- **Stay completely offline** — no internet, no sign-in, no cloud service.

### Not part of it (yet)

- Reading web pages or searching online.
- A *built-in / automatic* operating-system "locked box" around the AI. The permission checks below are
  always on; for full OS-level isolation you run the tool **contained** yourself — a ready Docker setup ships
  with it (see "Running contained" below), strongly recommended for `acceptEdits` / `bypass`.

---

## 3. What you need (one-time setup)

Three things. If someone has already set this up for you, jump ahead to section 4.

1. **Ollama** — the program that runs AI models locally. Get it from the official Ollama
   site, then start it once with `ollama serve`.
2. **At least one model.** The default is **`qwen2.5-coder:7b`** (small + quick) — install it with:
   ```
   ollama pull qwen2.5-coder:7b
   ```
   - **Use a tool-capable model — not just Qwen** (DeepSeek-Coder, Llama 3.1, Mistral-Nemo, …).
     ⚠️ The model **must support tool-calling (function calling)** — this is a tool-using agent.
     Models like **gemma / phi** do **not** support tools and will fail. See
     **"Optional — use a different model"** just below.
   - The larger `qwen3-coder:30b` is **optional** — only needed for multi-agent mode (`--multi`).
3. **Node.js**, version **22.6 or newer** — the runtime this tool uses.

> Nothing else to install — the tool uses **no outside packages**, only what ships with
> Node.js. On first start, a quick built-in check confirms Ollama is running and your chosen
> model is actually installed, and tells you exactly how to fix it if not.

### Optional — use a different model (DeepSeek, Llama, anything)

Skip this if you're happy with the default `qwen2.5-coder:7b`. To run **any other Ollama model**,
you point the tool at it using **two small files in the project folder** (the folder that has
`package.json`). **Neither file exists yet — you create each one by copying the example next to it.**

> ⚠️ **The model MUST support tool-calling (function calling).** This is a *tool-using* agent — it
> sends tools (read · write · edit · bash) on every request. Models that support tools include
> **qwen2.5-coder, qwen3-coder, llama3.1 / 3.2 / 3.3, mistral-nemo, mistral, command-r**. Models that
> do **not** — e.g. **gemma / gemma2 / gemma3, phi** — will fail at the first step with
> `400 … does not support tools`. Unsure? Run `ollama show <model>` and check for **tools** under its
> capabilities.
>
> **Pick a 7B+ tool-capable coder model** (e.g. `qwen2.5-coder:7b`). Tool-calling becomes reliable only
> around ~7B; **3B / 0.6B models often *narrate* ("I can read that file") instead of calling the tool**,
> even with a good prompt. The harness nudges once when a turn does nothing **or merely describes a tool
> action instead of calling it** (it re-prompts with the exact call format), but smaller models stay
> best-effort — for real work, use 7B+. (If a model gets stuck repeating the same action, the harness
> stops it with `[stopped: loop]` instead of grinding on.)
>
> **Remote `/v1` endpoints must forward tools too.** The model isn't the only thing that needs tool support —
> the endpoint does as well. Some hosted `/v1` gateways silently **strip the `tools` parameter**, so even a
> tool-capable model only chats/narrates. If the harness sees tools offered but never called for a whole run, it
> prints `⚠️ … may not support function-calling` — switch to a local Ollama coder model, or a `/v1` provider that
> forwards tools (e.g. Groq).

**Step A — pull the model in Ollama** (use your model's real tag; `ollama list` shows what you have):
```
ollama pull deepseek-coder:6.7b
```

**Step B — create `models.json`** by copying the example, then editing it:
```
# Linux / macOS
cp models.example.json models.json
# Windows (PowerShell)
Copy-Item models.example.json models.json
```
Open `models.json` and put your model under `"models"` (copy a block and change the tag):
```json
{
  "models": {
    "deepseek-coder:6.7b": {
      "name": "deepseek-coder:6.7b",
      "role": "general",
      "numCtx": 8192,
      "keepAlive": "5m",
      "sampling": { "temperature": 0.1, "top_p": 0.9, "top_k": 20, "repeat_penalty": 1.05 },
      "approxSizeGB": 4
    }
  }
}
```

**Step C — switch the tool to your file** by creating a `.env` file (again, copy the example):
```
# Linux / macOS
cp .env.example .env
# Windows (PowerShell)
Copy-Item .env.example .env
```
Open `.env` and set these two lines:
```
QWEN_HARNESS_MODEL_SOURCE=file
HARNESS_MODEL=deepseek-coder:6.7b
```

**Step D — start as usual:** `npm start`. The banner now shows your model. (You can also switch
models any time in chat with `/model <tag>`.) If a tag is mistyped or not pulled, the first-start
check tells you exactly what's missing.

> **Where these live & what happens if they're missing:** `models.json` and `.env` sit in the
> **project folder** (next to `package.json`). If they're absent, the tool simply uses its built-in
> defaults (Qwen) — nothing breaks. Both are kept private to your machine (git-ignored). You set this
> up just once.

### Adding several models at once (and what `role` means)

> **First, where is `models.json`?** It **does not ship** — the project only includes
> **`models.example.json`** as a template. You create `models.json` **once** by copying it (it lives in
> the project folder, next to `package.json`):
> ```
> cp models.example.json models.json            # Linux / macOS
> Copy-Item models.example.json models.json      # Windows (PowerShell)
> ```

Then list as many models as you like in it — they ALL go in the **same `models.json`**, under
`"models"`, **one block per model** (the key is the exact Ollama tag). Pull each one first with
`ollama pull <tag>`.

```json
{
  "models": {
    "qwen3-coder:30b":     { "name": "qwen3-coder:30b",     "role": "orchestrator", "numCtx": 32768, "keepAlive": "5m", "sampling": { "temperature": 0.1, "top_p": 0.9, "top_k": 20, "repeat_penalty": 1.05 }, "approxSizeGB": 18 },
    "qwen2.5-coder:7b":    { "name": "qwen2.5-coder:7b",    "role": "worker",       "numCtx": 8192,  "keepAlive": "5m", "sampling": { "temperature": 0.1, "top_p": 0.9, "top_k": 20, "repeat_penalty": 1.05 }, "approxSizeGB": 4.7 },
    "deepseek-coder:6.7b": { "name": "deepseek-coder:6.7b", "role": "general",      "numCtx": 8192,  "keepAlive": "5m", "sampling": { "temperature": 0.1, "top_p": 0.9, "top_k": 20, "repeat_penalty": 1.05 }, "approxSizeGB": 4 }
  }
}
```
Add as many blocks as you have models — same shape, with a comma between them.

**Every block needs:** `name` (the exact tag), `numCtx`, `keepAlive`, `sampling`, `approxSizeGB`, and `role`.

**`role` is one of three:**
- `"orchestrator"` — the lead / planner in multi-agent (`--multi`).
- `"worker"` — the light executor in multi-agent. The worker is auto-picked as the **smallest model
  you marked `"worker"`** — so mark your small, fast models as workers (e.g. 5 of your 10).
- `"general"` — everyday single-agent use.

**Every model shows up, whatever its role** — `/models` lists them all, and `/model <tag>` switches to
any of them at any time. `role` only decides which model becomes the multi-agent **worker**; it never
hides a model. (So your 5 "general" *and* 5 "worker" models all appear.)

**Which one runs by default:** the **first** block, unless you set `HARNESS_MODEL=<tag>` in `.env`.

---

## 4. Starting it, step by step

You'll type a handful of commands into a **terminal** (the plain text window).
Copying and pasting is perfectly fine.

**Step 1 — Start the AI engine.** Open a terminal and run:
```
ollama serve
```
Leave that window open. (If it reports that it is already running, that's fine — you
can close this one.)

**Step 2 — Open a second terminal** and move into the project folder:
```
cd path/to/qwen-harness
```

**Step 3 — Launch the assistant:**
```
npm start
```

You'll see a few lines like these:
```
qwen-harness  —  single (qwen2.5-coder:7b)  |  perms: default  |  cwd: path/to/your/project
session: a1b2c3d4   (resume later:  npm start -- --resume a1b2c3d4)
commands: /help  /model  /models  /mode  /context  /sessions  /new  /theme  /clear  /perms  /exit   (/help for details)
>
```
The `>` is your prompt. Type there. Above it, a status line shows the model, mode, folder, and how full the
context window is.

> **Nice touches (on by default in a terminal):** a live `/` command menu with **argument submenus** (`/mode`,
> `/theme`); **@** file mentions; fish-style **ghost-text** suggestions from your history (press → or End to accept);
> multi-line input; **paste** big blocks (they collapse to `[Pasted text #N]` and expand when you send);
> **undo/redo** (Ctrl+Z / Ctrl+_); a **kill-ring** (Ctrl+K/U/W → Ctrl+Y) with word-wise editing (Ctrl+←/→, Alt+D);
> Ctrl+R history search; and a `!`-prefixed **shell** escape. Tool approvals are an **↑/↓ + Enter** menu (allow once /
> always / deny), **Shift+Tab** cycles the permission mode, and a live **↑in ↓out** token counter shows per turn + in
> the status line. See your token usage with **`/cost`** and search the conversation with **`/search <text>`**.
> Name a chat with **`/rename <title>`**, then **`/resume`** and **`/model`** are **searchable** (type to filter).
> Answers render as colorized Markdown; edits show a colored diff with a **`+N -N`** added/removed summary.
> Type **`/help`** any time. Prefer plain text / the classic line editor? Set `NO_COLOR=1` (or `/theme never`), and
> use `QWEN_HARNESS_PLAIN_INPUT=1` for the plain readline REPL (Tab-complete + ↑/↓ history).

---

## 5. Talking to it

Write what you want in ordinary English and press Enter. For example:

- `What files are in this folder?`
- `Read notes.txt and sum it up in two lines.`
- `Create a file called todo.txt with three sample tasks.`
- `Find every file that mentions "invoice".`
- `Fix the spelling errors in letter.txt.`

As it works, it shows you each step:
```
  → read_file({"path":"notes.txt"})
  ↳ [allow] read_file:  1 Buy milk  2 Call mom ...

Your notes are a short shopping / reminder list.
```
- A line that begins with `→` means the AI wants to use one of its tools.
- `[allow]` means the action was safe (read-only) and ran automatically.
- The ordinary sentence at the end is its reply.

To **cancel a running task**, press **Ctrl+C** — it stops the request and brings you back to
the prompt. To leave, type `/exit` (or press Ctrl+C at an empty prompt, or Ctrl+D).

---

## 6. Staying in control: permission prompts

The assistant is deliberately cautious. Before anything that **changes a file or
runs a command** that isn't already trusted, it pauses and asks:
```
⚠️  Allow bash({"command":"npm test"})?  [mutating tool requires confirmation]  (y = once · a = always · N = no)
```
- Type **`y`** to allow it **once**.
- Type **`a`** to **always allow** that command — it's remembered (saved under `~/.qwen-harness/`), so the
  same command (and commands starting with it) run **without asking** next time, even after a restart. This
  is how the "runs without asking" set grows over time — you never have to pre-list commands. (See your
  remembered ones any time with **`/perms`**.)
- Type **`n`** (or just press Enter) to decline.

A small set of **clearly destructive commands** — for instance, anything that would
erase everything — is **blocked automatically**. It won't run them, and it won't
even ask.

Conversely, **safe read-only commands** — listing and finding files, searching, and
inspecting the machine (`ls`, `find`, `grep`, `ps`, `git status`) — run **automatically
without a prompt**, so exploring a project stays friction-free. Anything that could change
something still asks.

---

## 7. Permission modes (how often it asks)

Out of the box it asks before every change. If you'd rather not be prompted for a
task you trust, pick a different mode — either at startup or mid-chat:

- `default` — ask before each change (the safe default).
- `acceptEdits` — allow file edits without asking (destructive commands still blocked).
- `plan` — look only; make no changes at all.
- `bypass` — allow everything except the always-blocked destructive commands.

Start in a mode:
```
npm start -- --mode acceptEdits
```
Or switch while chatting:
```
/mode acceptEdits
```
**Always-on vs optional.** The permission gate, the destructive-command floor, and the loop/circuit breakers
are **always on, in every mode**. OS-level **containment is optional** — and it is the only real boundary.
Treat the command floor as a best-effort *tripwire*, NOT a guarantee: it cannot catch every form (e.g.
`rm -rf /etc`, `rm -rf .`, a bare `*`, or base64-encoded / `bash -c`-wrapped commands). For real isolation
(especially with `acceptEdits` / `bypass`), run the tool **contained**.

**Running contained (the real safety guarantee).** No command allow/deny list can be perfect — the durable
way to keep the agent off the rest of your machine is to run the whole tool inside a container, so even an
**unknown** destructive command can only touch the project you mount. **Recommended whenever you use
`acceptEdits` / `bypass`.**
- **Docker (any OS) — recommended:** a ready `Dockerfile` ships with the tool. Build once, then run with
  ONLY your project mounted writable:
  ```
  docker build -t qwen-harness .
  docker run --rm -it -v "$PWD:/work" -w /work \
    -e OLLAMA_BASE_URL=http://host.docker.internal:11434 \
    --add-host host.docker.internal:host-gateway \
    qwen-harness --mode acceptEdits "your task"
  ```
  Inside the container even `rm -rf` can only touch your mounted project — never your host. This is also
  the real defense against prompt-injection: a malicious file can't make the agent escape the container.
- **WSL2 (Windows):** run inside a WSL2 shell scoped to your project for the same effect.
- **A sandbox wrapper (Linux/macOS):** set `QWEN_HARNESS_SANDBOX` to a sandbox command and every **bash**
  command runs inside it — e.g. `QWEN_HARNESS_SANDBOX="bwrap --ro-bind / / --bind . . --unshare-net"`
  (bubblewrap) or a `sandbox-exec -f profile.sb` profile (macOS). Unset = normal behavior. On Windows this
  hook does **not** wrap PowerShell (a native Windows shell can't run inside a Linux sandbox) — use Docker or
  WSL2 for real Windows containment.

**Project conventions.** Drop an `AGENTS.md` or `.qwen-harness.md` in your project with rules (e.g. "answer
in French", "use tabs, not spaces") and the tool loads them into every prompt for that project.

**Per-project state.** Your "always allow" approvals and the assistant's long-term memory are kept
**per-project** (stored under your home dir, keyed by the project folder) — so an approval or a remembered
fact from one project never carries into another.

---

## 8. Choosing the model (quick vs. strong)

- **Quick (default):** `qwen2.5-coder:7b` — fast and light, great for simple jobs.
- **Strong:** `qwen3-coder:30b` — slower and uses more memory, better for harder
  problems.

Begin with the strong one:
```
npm start -- --model qwen3-coder:30b
```
Or change it during a chat:
```
/model qwen3-coder:30b
```
(Type `/models` to see the available names.)

**Have different models?** You don't have to use these exact two. Copy the file
`models.example.json` to `models.json`, list your own models in it, and start with
`QWEN_HARNESS_MODEL_SOURCE=file npm start`. If that file is missing or has a mistake,
the tool quietly falls back to its built-in defaults instead of breaking.

---

## 9. Teamwork mode (up to two helpers)

For a job that breaks into independent parts, one "lead" AI can pass pieces to
helper AIs:
```
npm start -- --multi "Create three files — a.txt, b.txt and c.txt — each with a short poem."
```
No more than **two** AI helpers ever run at once, so your machine stays responsive.

---

## 10. Stop now, continue later

Every chat is **saved automatically**. When it starts, note the **session id**
(for example `a1b2c3d4`). To return to that exact conversation another time:
```
npm start -- --resume a1b2c3d4
```
To see every saved chat:
```
npm start -- --list-sessions
```
While chatting, `/sessions` lists them and `/new` begins a fresh one.

> Very long conversations are trimmed automatically. It first shortens the bulkiest
> older results (such as long file or command output), and only if that isn't enough
> does it fold the older middle into a short summary — always keeping the most recent
> messages, so it never runs out of room.

---

## 11. Remembering facts between chats

Beyond a single conversation, you can ask it to keep a fact for the long term — a
preference, a project detail, anything worth holding onto. Just say so in plain
English, for example: `Remember that our reports go in the out folder.` In later,
separate chats it automatically brings back the facts most relevant to what you're
doing (and the most recent ones), without repeating duplicates. You can also ask
`What do you remember?` to see everything it has kept.

---

## 12. One-and-done mode

If you just want a single task handled without staying in the chat window, put the
request in quotes:
```
npm start -- "List the files here and tell me which is largest."
```
It does the job, prints the session id (so you can resume later if you like), and
then exits.

---

## 13. Quick cheat-sheet

| You want to... | Type this |
|---|---|
| Start chatting (quick model) | `npm start` |
| Start with the strong model | `npm start -- --model qwen3-coder:30b` |
| Do one task and quit | `npm start -- "your task here"` |
| Teamwork (up to 2 helpers) | `npm start -- --multi "your big task"` |
| Resume a past chat | `npm start -- --resume <id>` |
| List past chats | `npm start -- --list-sessions` |
| Start in a chosen mode | `npm start -- --mode acceptEdits` |
| (in chat) see all commands | `/help` |
| (in chat) switch model | `/model qwen3-coder:30b` |
| (in chat) pick a model from a list | `/model` (no argument → picker) |
| (in chat) save a default model | `/model qwen3-coder:30b --persist` |
| (in chat) check context usage | `/context` |
| (in chat) color on/off | `/theme never` (or `auto` / `always`) |
| (in chat) clear the screen | `/clear` |
| (in chat) switch to another chat | `/resume` (picker) |
| (in chat) free up context | `/compact` |
| (in chat) compose in your editor | `/editor` |
| (in chat) run a shell command | `!ls -la` |
| (in chat) change mode | `/mode acceptEdits` (or bare `/mode` to cycle) |
| (in chat) list chats | `/sessions` |
| (in chat) start fresh | `/new` |
| (in chat) quit | `/exit` |

---

## 14. Common questions

**Is my data private?**
Yes. Everything happens on your computer. Nothing is sent to the internet or to any
company.

**Could it damage my files?**
In the default mode it asks before changing anything, and it refuses obviously
destructive commands. Even so, keep backups of important folders — sensible with any
tool.

**It feels slow or hungry for memory.**
The strong `30b` model is large. For everyday tasks use the quick `7b` model (the
default), and close other heavy programs if needed.

**It gave me a wrong answer.**
Local models are smaller than big cloud ones. Try asking more specifically, or
switch to the stronger `30b` model. For questions about your files it always *reads*
the file rather than guessing.

**It says it can't reach Ollama (or a model is missing).**
When it starts, the tool checks what it needs and tells you exactly what's missing
and the simplest fix — for example, to run `ollama serve`, or to install a model
with `ollama pull <name>`. Follow the on-screen hint and start it again. (This check
runs only at launch, so it never slows things down once you're working.)

---

## 15. Where things are kept

- **Your chats and remembered facts:** a hidden folder in your home directory
  (`~/.qwen-harness/`).
- **The tool itself:** the `qwen-harness` folder you launched it from.
- **Your work:** it only reads or writes files inside the folder you run it in — paths that try to
  escape (`../…`, absolute paths outside it, or symlinks that point out) are refused.

**Scripting note.** For non-interactive use, pass the task in one shot —
`npm start -- "summarize README.md"` — rather than piping multiple lines into the prompt (when input
is piped, only the first line runs).

---

*That's everything. Run `npm start`, ask in plain English, and answer `y` or `n`
when it checks with you. Enjoy your private, offline AI helper.*
