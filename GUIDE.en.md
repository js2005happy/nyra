[中文](GUIDE.md) · **English**

# Nyra full guide

This is the complete reference for Nyra's features, commands and safety model. For an overview and a quick start, see the [README](README.en.md).

## Quick start

**New users: download and run, two steps** (Node single-file binary; no Python or Node needed):

```bash
# 1) Download: get the latest version from https://github.com/js2005happy/nyra/releases,
#    one file for your platform (Linux x64: nyra-linux-x64; Windows: nyra-windows-x64.exe;
#    macOS arm64: nyra-macos-arm64, Intel: nyra-macos-x64)
# 2) Run (Linux as the example):
chmod +x nyra-linux-x64
./nyra-linux-x64 setup      # first-run wizard (in Chinese, three steps to your first task)
./nyra-linux-x64 doctor     # self-check (in Chinese): key, network, folder permissions, disk
```

The Node binary is the full build (agent core, web interface, plugin marketplace and creation mode are all included).

> To build the binary from source yourself: `bash scripts/build-binaries.sh --only linux-x64` (output in `dist/`).

**From source (to build it yourself or read the code):**

Clone the repository first, then enter its folder; all of the commands below run inside that folder:

```bash
git clone https://github.com/js2005happy/nyra.git
cd nyra

# One-off task (configure a model first, see below)
bun run src/cli.ts "Create a file hello.txt with a greeting, then read it back and report"

# Interactive mode
nyra

# List skills and past sessions
nyra --list-skills
nyra --list-sessions
```

## Configuring a model

Nyra works with any OpenAI-compatible API. Settings are applied in this order of priority: command-line flags > environment variables > `~/.nyra/config.json`.

| Provider | Environment variable | Default model | Notes |
|---|---|---|---|
| deepseek (default) | `DEEPSEEK_API_KEY` | `deepseek-flash` | Cheap, good for everyday tasks; `deepseek-v4-pro` is stronger |
| xai (Grok) | `XAI_API_KEY` | `grok-4.3` | |
| openrouter | `OPENROUTER_API_KEY` | `nousresearch/hermes-4-14b` | Gives access to open-weight models such as Hermes |
| openlux | `OPENLUX_API_KEY` | `deepseek-v4.1-flash` | A relay service: one key for 300+ models (Claude/GPT/Gemini/DeepSeek/Qwen). Keys are billed by the group chosen when the key was created, and different groups carry different models; `--model` passes any model name through |
| ollama (local) | No key needed | `qwen2.5:7b` | Requires Ollama running locally |
| openai | `OPENAI_API_KEY` | `gpt-4o-mini` | |
| qwen (Tongyi Qianwen) | `DASHSCOPE_API_KEY` | `qwen-plus` | Alibaba DashScope compatible mode |
| kimi (Kimi) | `MOONSHOT_API_KEY` | `kimi-k3` | Moonshot AI, China-region endpoint |
| glm (Zhipu) | `ZHIPU_API_KEY` | `glm-5.3` | Zhipu BigModel compatible mode |
| gemini | `GEMINI_API_KEY` | `gemini-2.5-flash` | Google's OpenAI-compatible endpoint |
| mistral | `MISTRAL_API_KEY` | `mistral-small-latest` | |
| groq | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | Very fast inference, free tier |
| together | `TOGETHER_API_KEY` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | One key for hundreds of open models |
| custom | `NYRA_API_KEY` + `NYRA_BASE_URL` + `NYRA_MODEL` | — | Any compatible API (via environment variables) |
| codex | No key needed (uses the local Codex login) | `codex-default` | Calls the local `codex` CLI and reuses its ChatGPT subscription; makes no model API calls |

### Custom providers and listing models

Models not listed above can be connected too: as long as they speak the OpenAI `/v1/chat/completions` protocol, add an entry under `custom_providers` in `~/.nyra/config.json`. The key is only read from an environment variable and never written to the config:

```json
{
  "custom_providers": {
    "myllm": {
      "base_url": "https://llm.example.com/v1",
      "default_model": "myllm-1",
      "env_key": "MYLLM_API_KEY",
      "models": ["myllm-1", "myllm-2"]
    }
  }
}
```

- `base_url` and `default_model` are required, and `base_url` must be http/https. `env_key` is the name of the environment variable holding the key (leave it out if no key is needed, or use `NYRA_API_KEY`). `models` and `allowed_hosts` are optional; unknown fields are ignored.
- Plain `http://` is only allowed for local addresses (`localhost`, `127.0.0.1`, `::1`, e.g. a local Ollama); remote addresses must use `https://`, otherwise the API key would be sent in clear text. A remote `http://` address fails when the config is parsed, with a hint to use `https://`; even if a provider is constructed directly without the config parser, `chat()` / `list_models()` block it again before sending. Custom providers set through environment variables (`NYRA_BASE_URL`) follow the same rule.
- A custom provider with the same name overrides the built-in preset (for example, your own DeepSeek-compatible proxy can override `deepseek`). A malformed custom provider (missing `base_url`/`default_model`, protocol other than http/https) fails at parse time and is named in the error; it never silently stops working.
- Custom providers can be part of the fallback chain: `"fallback_providers": ["myllm", "deepseek"]`, or the environment variable `NYRA_FALLBACK_PROVIDERS="myllm,deepseek"`.
- When a provider needs a key and its environment variable isn't set, Nyra reports "API key not set" right away with a hint on how to configure it, instead of sending an unauthenticated request and waiting for a 401 from the server.
- Listing models: `nyra --list-providers` shows every provider and its default model; `nyra --provider qwen --list-models` asks that endpoint's `/models` API for the live model list (needs a key; local Ollama doesn't).

You can also use saved connector credentials: the DeepSeek and xAI keys have already been saved through the secure flow, so **no key needs to be entered**; just use them:

```bash
nyra --provider deepseek "do something"
nyra --provider xai --model grok-4.5 "do something"
```

Requests to local addresses (such as local Ollama at `localhost:11434`) always connect directly and ignore `HTTP_PROXY` / `HTTPS_PROXY`; all other addresses follow your proxy settings as usual.

Keys are only read from environment variables or saved connectors, and are **never** printed, logged or written into project files. The config is stored in `~/.nyra/config.json` (which contains no keys).

### Codex CLI provider (no API key)

`--provider codex` calls no model API. Instead it runs the locally installed `codex` CLI as a subprocess (non-interactively, via `codex exec`), reusing its own login and ChatGPT subscription:

```bash
nyra --provider codex "do something"
```

- **Model**: the default model name is `codex-default`, meaning "don't pass `-m`; let the CLI use its own default model". Tested: when signed in with a ChatGPT subscription, both `-m gpt-5` and `-m gpt-5-codex` are rejected by the server with `model_not_found` ("The 'gpt-5' model is not supported when using Codex with a ChatGPT account."); only leaving out `-m` works. If you set another model explicitly with `--model`, it is passed through as `-m`, and a server rejection is reported as a configuration error (no fallback, no retry burning another key).
- **Fixed prompt prefix (cache hits)**: every request starts with a byte-for-byte fixed English prefix (`CODEX_PROMPT_PREFIX` in `src/providers.ts`), followed by the messages serialized with `[role]` markers. The prefix is an identity and boundary statement: "You are Nyra, a text-only assistant. Reply in the user's language, concisely and directly. Do not call tools, run commands, browse the web, or modify files. Answer with text only." Because it is identical in every request and always comes first, the provider's prompt cache can hit this shared prefix, so repeated calls only pay for the new tokens. Note: the prefix only constrains the text model's identity and behavior and passes no tool schemas. `codex exec` itself has no "chat only" switch and still runs its own agent loop; the real hard limits come from the read-only sandbox and the temporary working folder (see below).
- **How it's called**: a fixed argv: `codex exec --json -o <temp file> -s read-only -C <empty temp working folder> --ephemeral --skip-git-repo-check -c features.browser_use=false -c features.computer_use=false -c features.plugins=false` (no `-m` with the default model). The prompt is passed on stdin (not in argv, so `ps` can't see it). On success it reads the final message from the `-o` file first, and falls back to parsing the `--json` JSONL event stream if the file is empty; usage is recorded when it can be parsed. The timeout is enforced on Nyra's subprocess side (`codex exec` has no `--timeout` flag), and on timeout the whole process group is killed.
- **Four safety conditions (enforced in code and covered by tests)**:
  1. **Fixed paths only**: the `codex` binary is resolved only from fixed known locations (`/opt/hatch-image/bin/codex`, `~/.local/bin/codex`, `/usr/local/bin/codex`, `/usr/bin/codex`, plus two fixed candidates on Windows), with `shutil.which("codex")` only as the last resort. The path is never taken from config, environment variables or user input (variables like `NYRA_CODEX_PATH` are ignored).
  2. **Login credentials are never touched**: CLI credential files such as `~/.codex/auth.json` are never read, copied or logged. The login check only runs `codex login status` and reads only the exit code and the "Logged in" marker (which, in testing, goes to stderr). The subprocess environment has every `*_API_KEY` variable removed, so the CLI relies only on the login in its own HOME.
  3. **No approval-skipping flags**: `--dangerously-bypass-approvals-and-sandbox`, `--approve-for-me`, `--dangerously-bypass-hook-trust`, `-y` and `--full-auto` are never passed; once argv is built it is self-checked, and any forbidden flag means the call is refused. The call is always `-s read-only`, and the working folder is a new empty temporary folder each time, deleted afterwards.
  4. **Never in the fallback chain**: it can only be selected explicitly (`--provider codex`, config, `POST /api/provider`) and is never a fallback target. `resolve_fallback_chain("codex")` returns only `["codex"]`; codex appearing in a chain is skipped and logged. It is never used in scheduled tasks or the queue: constructing a `Provider` directly is refused when its auth is CLI (the constructor guard in `src/providers.ts`), and scheduled tasks and the queue construct providers directly, so choosing codex there fails before anything starts.
- **Claude to-do**: this round only covered Codex. The Claude CLI (`claude`) isn't installed on this machine yet, and `claude --version` and its login need to be checked on the user's computer (Windows) first; after that it will be connected under the same constraints.

### Background task worker (0.4.0)

The Python worker (`nyra.worker`, stdio JSONL protocol v1) was removed together with Python in 0.4.0. The hybrid Go approach was dropped (replaced by a complete Node runtime, see `docs/node-migration-phase*.md`). Background tasks now run on the native Node task queue: `nyra task add` enqueues, `nyra task worker` consumes and runs, and `nyra task list/show/cancel/approve` manage them. Approval and timeout rules match the main loop; protocol details are in `src/tasks.ts`.

### Automatic model fallback

When the main model call fails, Nyra can automatically move to the next model in a chain and retry once, without you switching models by hand. The default chain is DeepSeek flash → Grok → local Ollama (the main model is always first, and every call starts by trying the main model).

- Failures that trigger fallback: insufficient balance (402), rate limiting (429), server errors (5xx), timeouts, network errors.
- Failures that don't: authentication failures (401/403; another model won't fix that), configuration problems (no key set, unparseable response, and so on).
- **Off by default**, and only you can turn it on (any one of): set `"fallback_enabled": true` in `~/.nyra/config.json`; the environment variable `NYRA_FALLBACK=1`; or `--fallback` for a single run. To turn it off: `"fallback_enabled": false`, the environment variable `NYRA_FALLBACK=0`, or `--no-fallback` for a single run (when both `--fallback` and `--no-fallback` are given, off wins).
- Allow list: it only switches to providers listed in `fallback_providers`. To change the chain: set `"fallback_providers": ["deepseek", "xai", "ollama"]` in `~/.nyra/config.json`, or the environment variable `NYRA_FALLBACK_PROVIDERS="deepseek,xai,ollama"` (comma-separated; the main model is placed first automatically; unknown names are skipped with a log line; an explicitly empty list means no fallback is allowed, and the default chain is not silently filled in). Providers in the chain without a configured key are also skipped with a log line. Fallback models use their own default models; custom provider names can be in the chain too.
- Every switch is announced clearly: on the command line via stderr (stdout of a one-off task still contains only the answer), e.g. `模型切换：ollama 失败（网络错误……），已切换到 deepseek 继续` ("model switch: ollama failed (network error…), switched to deepseek to continue"); `--json` emits a `model_switch` event in the output; the web chat stream shows a line like "模型已切换：deepseek → xai（402 …）" ("model switched: deepseek → xai (402 …)") and refreshes the model card; in group chats, the switch notice appears under the bot's reply as well.
- When every fallback model fails, the error lists why each model failed; it never fails silently.
- Wired into the command-line entry points (interactive REPL, one-off tasks, `--plan`), `--json` single-run mode, the web interface and group chats: when the main model hits a recoverable failure, they all switch along the same chain. `--json` states exactly which provider was finally used (`run_started` is the main model it started with, `run_completed` / `run_incomplete` is the model that actually answered, plus `model_switch` events and a `model_switches` list); the web interface's info panel also shows the model that actually answered and the switch history. Scheduled tasks and the queue don't switch: a scheduled task still uses a single provider (the scheduler constructs `Provider` directly, see the constructor guard in `src/providers.ts`).

## Features at a glance

- **Plan first, then act**: `--plan` produces `plan.md` read-only; you review it and approve it by SHA-256, and changing a single byte invalidates the old approval.
- **Asks you at every step**: writing files and running commands are approved one by one by default; `apply_patch` saves a checkpoint before editing, and `/undo` and `/rewind` roll back any time.
- **Research with evidence**: source text fetched by `web_search` / `web_fetch` is saved as evidence, and conclusions must cite sources.
- **MCP and skills**: standard MCP servers (stdio) plug straight in, and the `skills/` folder extends what it can do.
- **Works on its own**: a built-in scheduler runs tasks at intervals or at a set time each day.
- **Multi-bot group chats**: several bots share the work in one room, each with its own permissions.
- **Any model**: more than ten OpenAI-compatible APIs including DeepSeek, Grok, OpenAI, Qwen, Kimi, Zhipu, Gemini and local Ollama; `profiles` switch in one step, and failures fall back automatically.
- **Transparent usage**: `/status` shows real token usage and remaining context, and `/compact` compresses long sessions.
- **Web interface**: `nyra ui` opens a local web UI.

> All of the code is original. It only borrows design ideas from open-source agents such as Codex, OpenCode, Goose and OpenHands (sources in [DESIGN.md](DESIGN.md)); no source code was copied.

## Website

The project website is a plain static single page in the `docs/` folder (`index.html` + `style.css` + `main.js`), published by GitHub Pages from `/docs` on the `main` branch at <https://js2005happy.github.io/nyra/>. There is no build step, external CDN, external font or tracking script. It follows the browser language by default (Chinese or English) with a 中 / EN switch at the top right, and supports phones and dark mode. All content comes from the README, DESIGN.md and CHANGELOG.md. To preview locally, just open `docs/index.html` in a browser. Checks that the page exists, internal links/anchors work and no external resources load had no Node equivalent test as of 0.4.0; still to do.

## New in 0.2.0 / 0.3.0

- **E2B sandbox** (0.3.0, removed in 0.4.0): `--sandbox e2b` used to run file reads/writes and shell commands inside an E2B sandbox without touching the local machine. It was removed together with Python in 0.4.0; the Node E2B backend hasn't been ported yet, so only `--sandbox local` is supported for now.
- **MCP client**: connects to standard MCP servers (stdio JSON-RPC, protocol 2026-07-28; older servers automatically fall back to the `initialize` handshake). With `mcp_enabled: true` and `mcp_servers` configured, a server's tools show up in the tool list as `mcp_<server>_<tool>`. Off by default; enable it explicitly.
- **Built-in scheduler**: `nyra schedule add --name daily-cleanup --prompt "Tidy up the Downloads folder" --every 86400`, then `nyra schedule daemon` runs the daemon. Tasks are stored in `~/.nyra/schedule.json`, at an interval or at a fixed time each day (`--at 08:30`).
- **Session compaction**: `nyra --compact <session id>` or `/compact` in the REPL has the model summarize a long session into key points and continue from there; if the model fails, a local fallback keeps the first and last messages.
- **Evidence trail**: page text fetched by `web_fetch` / `web_search` is saved automatically as in-session evidence (`~/.nyra/evidence/<session id>/`). Conclusions must include source links and can be re-checked against the evidence.
- **New tools**: `grep_search` (search file contents), `git_status` (read-only git status / diff stats), `http_post` (requires approval).
- **Provider profiles**: `profiles` in the config can store several named profiles, switched with `--profile strong`; an explicit `--provider` / `--model` / `--mode` takes precedence over the profile.
- **web_search fixed**: two backends, Bing first and Baidu as fallback (following IllusionAgent's approach). It only reports a clear error when both fail, and never makes up results.

## Optional EigenFlux setup (bare CLI, offline by default)

Nyra can give the main agent and every group-chat bot you've created its own **separate, stable** EigenFlux home, and check whether the official CLI and skills are already on this machine. This feature doesn't install, authenticate, register, broadcast, read private context or create scheduled tasks on its own. It is also **not** a client already connected to the EigenFlux network.

```bash
# Only generate a local readiness report; no network access, no EigenFlux CLI call
nyra eigenflux doctor
nyra eigenflux doctor --room alpha --bot lead

# Explicitly run the two local official verification commands; still doesn't start onboarding
nyra eigenflux doctor --check
nyra eigenflux doctor --room alpha --bot lead --check
```

By default the main agent's home is `~/.nyra/eigenflux/agents/main/.eigenflux`; each bot in a newly created group chat uses `~/.nyra/eigenflux/agents/rooms/<room>/instances/<random instance ID>/bots/<bot>/.eigenflux` (older groups keep the previous path for compatibility). That way, deleting and recreating a group with the same name can't accidentally reuse old identity keys. These homes are separate from Nyra's group-chat memory and session files, and a bot can't borrow another bot's identity or credentials. The EigenFlux CLI must be passed the same `--homedir` explicitly, and the last part of the home path must be `.eigenflux` so the CLI doesn't add another folder level.

`--check` only calls `eigenflux --homedir HOME version` and `eigenflux --homedir HOME skills path --host terminal` from the existing PATH, without a shell, with a time limit, and with a minimal environment for the subprocess so model API keys and other proxy credentials aren't handed to the diagnostic CLI. A successful check only means the local tools work; it **does not mean email verification, network identity, user authorization or inbox subscriptions are done**.

Installing needs your separate authorization, and you should review the [official EigenFlux install guide](https://github.com/phronesis-io/eigenflux/blob/main/skills/install.md) first. For unofficial hosts on macOS/Linux, the `EIGENFLUX_SKIP_AGENT_SETUP=1` bare-CLI route is recommended. The official Windows PowerShell installer integrates with hosts differently from Unix, so don't assume it has set up Codex/Claude plugins. The official EigenFlux installer is external code, and Nyra never runs it for you in doctor. Email OTP, the Agent Card, public broadcasts and recurring subscriptions all go through the later `ef-onboarding` with confirmation in the foreground; agreeing to install is not permission to act on the network.

## EigenFlux local network permission limits (per bot, everything denied by default)

Nyra can set local limits on network actions for the main agent and for **each individual bot** in a group chat. This is only an extra Nyra-side restriction: it doesn't replace the official `ef-onboarding` user confirmation, and it doesn't register accounts, open network channels, access private context or act as an authenticated credential.

```bash
# The main agent denies everything by default; show the six available actions
nyra eigenflux policy show

# Show the limits of the lead bot in group chat alpha
nyra eigenflux policy show --room alpha --bot lead

# Explicitly record a local intent to allow it to read the feed "in the future, after official authorization"
nyra eigenflux policy allow --room alpha --bot lead --capability feed_read --confirm

# Withdraw that local intent
nyra eigenflux policy deny --room alpha --bot lead --capability feed_read

# Show this bot's local change history
nyra eigenflux policy audit --room alpha --bot lead
```

Only fixed actions are accepted: `feed_read`, `public_broadcast`, `direct_message`, `relationship_request`, `recurring_check`, `profile_prefill`. Every `allow` needs an explicit `--confirm`; `*` or "all actions" grants are not supported, and `deny` removes a local permission immediately. `--expect-revision SHA256` is supported to stop an admin from changing things based on stale state. **A local allow intent does not let these network actions actually run**: `effective_network_permission` and `network_actions_enabled` are always `false` at this stage. Official network authorization, sign-in, host execution permission and review before public posting must each still be in place separately.

Permissions are stored in `~/.nyra/eigenflux/network-policy.json`, separate from each bot's `EIGENFLUX_HOME` credential files, with private file permissions, atomic writes and SHA-256 version checks. It keeps up to 250 local audit events (not tamper-proof). Changes within one process are locked; races between processes on the file still need hardening. Group chats use a random instance marker, so a group recreated with the same ID after deletion doesn't inherit the old group's network permissions or EigenFlux home; older group chats keep their original paths for compatibility.

This feature doesn't run any network commands of the official EigenFlux CLI yet. Even when set to `allow`, it won't trigger `ef-onboarding`, read the feed automatically, post broadcasts or set up recurring tasks. A future network execution gateway must re-check the local limits and the **separate official authorization** before every action. It makes no claim to control the EigenFlux CLI when you run it directly outside Nyra.

## Two-phase plan mode (review first, then execute)

First generate a plan in the project folder without changing any code:

```bash
nyra --workdir . --plan "Assess the login logic and list the steps to fix it"
```

While planning, only `read_file` and `list_dir` are available, and reads are limited to the working folder; no shell, MCP or regular agent session is used. When done it produces only `plan.md` and prints its full SHA-256. Model calls may still be billed.

After reviewing `plan.md` yourself, copy the full 64-character SHA-256 and approve that version for execution:

```bash
nyra --workdir . --execute-plan --approve-plan FULL_SHA256
```

Changing any byte of the plan invalidates the old approval. **Approving a plan doesn't skip tool approvals**: execution defaults to `auto`, and every file write or command still needs your OK; only an explicit `--mode full` skips the step-by-step confirmations. Only a local working folder is supported for now, and it can't be combined with `--json`. This is not an operating-system sandbox; review the scope and risk of the changes yourself.

## Token usage and context status

Nyra now counts the token usage **actually returned** by the model API. Type `/status` in the interactive terminal to see the number of calls, input/output tokens, the input length of the most recent request and the approximate remaining context; the web UI has a **Token usage** status panel on the right. When a one-off task finishes, the stats go to **stderr**, so they don't pollute the task result on stdout, which suits future script/JSON modes.

```bash
nyra --context-window 8192 "Check this project"
nyra                 # then type /status
```

If you know the official context limit of your current model, set `--context-window N` or `"context_window_tokens": 8192` in `~/.nyra/config.json` (the number is only an example, not a claim about any model's limit). Without it, the status clearly shows **unknown**; if the API provides no usage field, Nyra doesn't fake exact tokens from character counts. **Approximate remaining context** is the configured window minus the input tokens of the most recent request. It doesn't include the latest output, the next turn's new input or any extra reserve the model keeps, so don't treat it as a strict count of usable tokens left. Totals only count model replies in the current agent process; reloading a past session doesn't back-fill earlier calls.

Further work is ordered in [ROADMAP.md](ROADMAP.md); next is automatic session compaction based on real usage and conservative thresholds.

## Poppy OAuth issuer two-way verification (first security increment of phase 3)

Without a model API key and **without signing in**, Nyra can verify whether a Poppy 1.0 company declares its OAuth issuer correctly:

```bash
nyra --inspect-poppy-identity https://shop.example.com
```

Order of checks: first read the Poppy 1.0 discovery file; then read `/.well-known/oauth-protected-resource` on the company's domain and confirm that `resource` is the company's **exact HTTPS origin**; if there is an OAuth issuer, read the issuer's `/.well-known/oauth-authorization-server` metadata per RFC 8414, verify that the issuer **matches exactly**, that the reverse `protected_resources` includes the company's domain, and check the token/revocation endpoints and required claims such as `refresh_token`. With several authorization servers, Poppy's `auth.issuer` must pick one explicitly; otherwise it's refused.

A 404 can show that a site currently has no issuer, but the signed-out-only marker is allowed **only on an actual 404 or valid metadata with no issuer**. Timeouts, 403s, broken JSON, certificate errors and an issuer that doesn't point back to the company must all fail; none of them may pretend to be guest mode. Metadata reads still use public DNS/IP checks, a pinned IP + TLS hostname verification, HTTPS and size limits, and never follow metadata redirects.

With an explicit `--poppy`, the model gets an additional read-only `poppy_identity_check` tool to query the metadata verification status; it isn't available by default. The `issuer_link_verified` output only means **the public metadata's ownership was verified in both directions**. It doesn't mean the user has authorized anything, OAuth client registration is done, a token is usable or a Poppy Session JWT has been signed. `session_ready`, `oauth_ready` and `remote_calls_allowed` are all still `false`.

**Required next steps**: secure private-key storage and `private_key_jwt`, Poppy ES256 delegated signing and per-request JWTs, real OAuth interaction and DPoP, and an HTTP MCP transport with scope checks and approvals. Pieced-together unsigned JSON must not be called a usable Poppy Session; a full cryptographic implementation may need audited cryptography dependencies, and no home-made crypto should be written just to stay within the standard library.

## Poppy site permission ledger: exact site × identity × scope (phase 2)

Nyra adds a **local authorization intent ledger** that denies any unregistered site/identity/scope by default. All changes can only be made explicitly by the user through the `nyra permissions` command; the agent can only query it read-only. **What is recorded here is the user's local preference, not OAuth consent, a valid access token, a Poppy Session or a permission on the company's server.** No remote call channel exists yet, and no record lets the agent perform remote actions directly.

```bash
nyra permissions list
nyra permissions check --site shop.example.com --scope orders:read
nyra permissions grant --site shop.example.com --scope orders:read --account personal --confirm
nyra permissions check --site shop.example.com --scope orders:read --account personal
nyra permissions audit --site shop.example.com
nyra permissions revoke --site shop.example.com --scope orders:read --account personal
```

Without `--account` the identity is `visitor`; `--account personal` means a local account slot named `personal`, **not that you are signed in**. Different accounts, scopes and subdomains of the same site are strictly isolated, and there are no wildcard grants. `grant` must include `--confirm` explicitly. `list` returns the ledger's SHA-256 version, and changes can use the optional `--expect-revision` to reject stale writes.

It is stored in `~/.nyra/poppy/permissions.json` with minimal local file permissions, and keeps a bounded audit of the most recent 300 grants/revocations; no passwords or tokens are stored. An in-process lock and atomic replacement prevent overwrites within one process, but several Nyra processes can still race, and this audit record is **not a tamper-proof audit log**.

With `--poppy`, the agent only gets the additional `poppy_permission_check` query tool, not grant/revoke tools. The change risks described by Poppy 1.0's official `scope_hints` are `none`, `reversible` and `irreversible`; unknown risk values are treated as irreversible, and a missing `personal_data` is treated as unknown. Even if a site claims a low risk, that never replaces the user's approval. When OAuth/HTTP MCP is implemented later, the token's actual scopes, account and session must still be verified independently, and writes or unknown-risk actions need human approval each time.

## Poppy 1.0 public protocol discovery (off by default, phase 1)

Nyra's Poppy support follows a gradual **discover, then authorize, then call** architecture. Phase 1 is read-only discovery using only the standard library: it reads `https://<domain>/.well-known/poppy.json`, validates `protocol_version`, the domain that actually served the file and the redirect destination the spec requires, and lists the company's agents, MCP, OpenAPI, web channels and public scope descriptions. **It doesn't create a Poppy Session, run UCP shopping, call the declared remote MCP/API, or attempt an OAuth sign-in.**

Check a site straight from the terminal, no model API key needed:

```bash
nyra --discover-poppy https://example.com
```

Explicitly let the agent check structured discovery first, then complete an information task with the usual web search/read tools:

```bash
nyra --poppy --mode readonly "Look at example.com's public capabilities and product information"
```

There is no `poppy_discover` tool by default; `--poppy` must be given on the command line. `--json --poppy` also supports this read-only tool. Standard Poppy 1.0's HTTP Streamable MCP, Session JWT, OAuth issuer ownership verification, permission ledger and UCP actions are **not implemented yet**, so the tool only lists capabilities and doesn't automatically wire advertised endpoints into the existing stdio MCP client. Discovery results come from third-party sites and are untrusted data.

Security boundaries: only public DNS domains over HTTPS on the default port 443 are accepted; private/loopback/reserved addresses, usernames/passwords in URLs and non-HTTPS redirects are refused, and TLS verifies the certificate against the original hostname while connecting to the already-checked public IP. The spec allows cross-host redirects, but the final address must be exactly `/.well-known/poppy.json` with no query string; documents for alternative versions are only allowed on the same host and may not redirect. Files are at most 128 KiB, with at most 4 redirects. Only documents marked 1.0 are implemented (discovering a same-host 1.0 alternative from a preferred older version is supported); other incompatible versions are refused.

These protections don't amount to a full network sandbox, nor do they complete the OAuth, signing, session and other security checks Poppy 1.0 requires. Work will continue by protocol version, connecting remote HTTP MCP after user authorization; when that isn't available it keeps using the existing `web_search`/`web_fetch`, and without browser automation it doesn't claim it can fall back to driving a browser.

## Long-term memory browser (web UI)

Nyra's `MEMORY.md` is not part of the session JSONL: every new session can re-read long-term memory, and neither manual `/compact` nor automatic context compaction rewrites this file. **Note: the agent currently usually injects only the last 40 lines of long-term memory into the model prompt, so not all past memory is used by the model at once.**

Start `nyra ui` and click **Long-term memory** at the top to pick "Nyra · global memory" or a bot in a group chat you've created, and browse its full Markdown memory text. The global file is `~/.nyra/MEMORY.md`; each group-chat bot has its own `~/.nyra/groups/<group ID>/bots/<bot ID>/MEMORY.md`, not shared with others.

You can edit, clean up and save the current bot's memory right in the web page. Every read returns the whole file's SHA-256 version, and saving must submit that version: if another agent appended memory in the meantime, the server returns **409 Conflict** and keeps the existing data, never overwriting silently. `memory_append` and web saves within the same Node process share a lock; there's no cross-process lock for simultaneous writes from several processes yet, so run only one Nyra instance per memory file.

The API is protected by the web UI's existing random token and local Host check, and memory content isn't leaked through unrelated APIs such as model info or the session list. Memory supports UTF-8 only, the web editor is limited to 64 KiB per file, and existing memory files that are symlinks can't be read or written from the web page. Save your changes manually; new long-term memory takes effect on the next agent request. Please don't copy sensitive memory into public chats or screenshots.

## Memory mode: reading other agents' memory

Nyra can read other agents' memory, following Muse's memory-import model: snapshot import/export and chat import, plus reading memory from a paired machine and reading local files. Everything is read-only and append-only, and content is redacted before import.

**Snapshot export/import**: `nyra memory export` exports its own memory as a Markdown snapshot with five fixed chapters (Identity / Facts / Preferences / Goals and commitments / Relationships), leaving out chapters with no reliable information. `export-prompt` prints a prompt you paste into another AI chat so it outputs a snapshot in the same format. `import [FILE]` (reads stdin if no file is given) merges a snapshot into `~/.nyra/MEMORY.md`, append-only without overwriting, skipping content that's already there. Both export and import redact first: lines containing passwords, keys or tokens are removed and counted.

**Reading memory from a paired machine**: after pairing with another Nyra, `nyra memory peer <pairing code> [HOST PORT]` reads the other side's memory snapshot and imports it. The host serves GET /memory (Bearer token required, returns a redacted snapshot), and the guest redacts it once more. Only use this on a trusted network; see the pairing-code collaboration section for the pairing rules.

**Reading local files**: `nyra memory local codex` reads the local `~/.codex/memories_1.sqlite` (opened read-only; the local Codex version has no memories table and keeps memory in stage1_outputs.raw_memory, and both layouts are supported). `local claude` reads `~/.claude/CLAUDE.md` and `MEMORY.md`; `local dir <folder>` reads MEMORY.md / AGENTS.md / CLAUDE.md in the given folder. If a file isn't found or the database has no content it reports "not found" and makes nothing up. What it reads is converted to snapshot text and goes through the same import-and-merge path.

**Chat import**: `nyra memory import-zip FILE.zip` supports ChatGPT / Claude chat exports (conversations.json). It only lists and archives: it parses the conversations (title, date, message count), stores the original text in `~/.nyra/memory-imports/<date>-<source>/`, and appends only one import-record line to MEMORY.md. It doesn't extract facts automatically (that needs model calls and would invent things); extraction will later be done with the knowledge base's ask.

## Multi-bot group chats (Node core + JavaScript interface)

Start the local web interface:

```bash
nyra ui
```

Click **Bot group chat** at the top of the page, then **New group**. By default it creates four separate bots: lead, architect, builder and reviewer; you can set the model provider and model ID for each when creating it. Each bot has its own system instructions, session history, long-term memory and working folder, rather than one model playing several roles.

- Send a task in the group: every member gives its view and proposes solutions, and they can push back on each other.
- Use `@architect`, `@builder` and so on to assign work and wake only those bots; you can @ several at once.
- Explicitly choose 1 or 2 rounds of discussion in the group, with at most 6 members and at most 3 model calls per bot per turn.
- Bots are `readonly` by default, so creating a group chat never starts running commands on this machine on its own. **This version can do independent analysis and read-only tool calls; it can't modify a project unattended or run things in parallel in the background.**
- Model API costs only occur when you send a group message yourself. If a model isn't configured or fails, the error is marked in the group message; it never fakes success.

Data is stored in `~/.nyra/groups/<group ID>/room.json` and each member's private `bots/<member ID>/` folder; each member's session is a separate `~/.nyra/sessions/group-<group ID>-<member ID>.jsonl`. Group messages are shared context, but each bot's memory file is separate. The browser group-chat page (HTML + JS) is bundled into the Node binary (`src/assets/`) and reuses the Node agent core and HTTP API. This folder isolation is not an operating-system sandbox.

**Group chat safety**: don't treat AI suggestions in the group as actions that were actually carried out. It is currently read-only by default, with limited discussion rounds and model calls; multi-agent write permissions, a task queue, parallel scheduling and human approvals will come in stages. The group chat page and API keep using the Nyra web UI's local listening and access-token mechanism.

## apply_patch edits and /diff

Nyra has an `apply_patch` tool that edits an existing **local text file** strictly with a single-file unified diff. The patch must include `--- a/<relative path>`, `+++ b/<relative path>` and `@@ -<old line> +<new line> @@`, and every line of original context must match exactly; no guessed matches, out-of-bounds writes or multi-file changes in one go.

Tool example: `path="src/sample.py"`, with this `patch` content:

```diff
--- a/src/sample.py
+++ b/src/sample.py
@@ -1,2 +1,2 @@
 print("start")
-print("old")
+print("new")
```

In interactive `auto` mode, the approval summaries for `apply_patch`, `write_file`, `edit_file` and regular `plan` local changes now show a unified before/after diff. Web approval cards keep line breaks and scroll. Previews are capped at 6000 characters; when the source file or the result is over 128 KiB, a clear "can't preview" notice is shown instead to avoid an expensive diff, and it must not be treated as fully reviewed. Every patch needs approval and doesn't inherit long-lived grants from other file tools. Approval logs may contain file contents, so don't publish them casually.

The terminal has `/diff` to view the changes of the **most recent checkpoint not yet undone** in this session. External modifications show as conflicts, so someone else's edits are never counted as Nyra's work. Patches work with existing checkpoints, so you can `/undo` afterwards.

Only existing local text files are supported for now. Creating/deleting files, renames, multi-file patches, OS-level isolation and atomic commits across files aren't implemented yet; `/diff` isn't a full `git diff` and can't track external side effects from the shell, MCP, HTTP and so on.

## Checkpoints before writes: /undo and /rewind

Interactive Nyra now creates task checkpoints automatically for the **local** built-in file tools `write_file`, `edit_file` and `plan`: the first time a user task modifies a file, its original bytes are kept (including files that didn't exist before), and later writes in the same task only update the final file hash. Checkpoints are isolated per session and working folder and stored in `~/.nyra/checkpoints/`; no plugin needed.

```text
/undo           # undo these local file changes from the most recent task turn
/rewind 3       # undo the last three turns; checks everything first and changes nothing if there's a conflict
```

Before undoing, it verifies file by file that the current content hash still matches what Nyra last wrote. If a file was changed by you, another bot or an outside process, the operation is **refused and the external change is not overwritten**. Undoing a created file deletes it; undoing an overwrite restores the original binary bytes; other files are untouched. A checkpoint holds at most 20 files, each at most 2 MiB, at most 20 checkpoints not yet undone are kept, and `/rewind N` goes back at most 10 turns at a time. Beyond these limits, Nyra refuses checkpointed file writes rather than making changes it couldn't safely restore.

After undoing, a note is recorded in the current session telling the model that earlier tool-success records are no longer valid; earlier messages are not rewritten automatically. `/new` starts a separate set of checkpoints for a new session, and `--resume` in the same working folder can keep using the checkpoints saved earlier.

**What can't be undone**: the shell (including subprocesses it starts), MCP, HTTP requests, memory/skill files, and external side effects outside other agents. Atomic file replacement also can't guarantee that restoring several files together is immune to a system failure. Checkpoints are not a full backup or an OS sandbox; use them alongside Git.

## Precise file and shell grants (security hardening)

In interactive `auto`, `a` (always allow for this session) now applies only to **the same file and the same tool**. Paths are normalized before granting, so equivalent relative/absolute paths to the same file don't need approval again, while other files still need fresh approval. For the shell, a cached grant is bound to **the exact same command text, normalized starting folder, timeout, execution backend and workspace**. Changing folder or backend, or raising the timeout, doesn't reuse an old grant; the web UI's per-item approval callback always takes precedence over the terminal cache. The web UI's "always allow for this session" uses the same scope but is tracked separately: terminal grants don't approve web requests, and web grants don't approve terminal requests.

The shell's starting `cwd` must now be inside `--workdir`; absolute outside paths, `../` and existing symlinks pointing outside are refused before execution and before human approval. **This only limits where the shell starts**: commands can still reach outside the working folder with `cd`, absolute paths, redirection or other programs. It is not a shell/OS sandbox; process isolation and tool-execution auditing are still needed.

## Working-folder write boundary and per-session approvals

`write_file`, `edit_file` and the regular `plan` file tool now refuse **by default** to write outside `--workdir`, and `full` can't bypass this. That covers absolute outside paths, `../` escapes and existing symlinks pointing outside; valid paths inside the working folder still work.

In interactive `auto` mode, every file write or shell command prompts `[y/N/a]`: `y` approves once, and `a` means **always approve for this session** this kind of file tool (write_file/edit_file/plan are tracked per tool), or for the shell **the exact same command string and cwd**. A shell prefix is never treated as a whitelist for running anything; MCP, HTTP POST, memory and skill operations are still approved each time. `/new`, `/clear` and switching `/mode` clear session approvals; background non-interactive `auto` and `readonly` never write because of a cached approval. Web approvals still ask for authorization on each tool call.

**Boundary note**: the working-folder write check only covers the built-in file tools above; it doesn't stop the existing `shell` from using absolute paths, changing folders or starting other programs while it runs. `memory_append`, `save_skill` and evidence/session storage write to Nyra's own data folder by design and are known exceptions. There may also be a race between the check and the write, so this is not a full operating-system sandbox. When running untrusted code, use a protected isolated environment and keep reviewing commands. A stronger shell sandbox and a precise command allow list are on the list of later security work.

## Approval modes

| Mode | Behavior |
|---|---|
| `readonly` (read-only) | Can only read files and look things up online; can't write files or run commands |
| `auto` (default) | Asks you to confirm before writing files/running commands (`[y/N]`); when running non-interactively (e.g. cron) it never writes quietly, and you must add `--mode full` |
| `full` (full access) | No confirmations, runs directly; for tasks you explicitly trust and background runs |
| `creator` (creation mode) | Build a plugin from one sentence: agree on a spec, generate, verify, and ask you before installing; file writes and commands are confirmed one by one, as in `auto` |

```bash
nyra --mode readonly "See what's in this folder"
nyra --mode full "Tidy up the Downloads folder"
```

**Built-in MCP presets**: Nyra ships with 10 preconfigured MCP servers, so you don't have to write `mcp_servers` by hand. Just set `"mcp_enabled": true` in `~/.nyra/config.json` and 4 are on by default: memory (knowledge-graph memory), sequential-thinking (structured thinking), fetch (web page to Markdown) and time (time and time zones). To turn on more, add names to the `mcp_presets` list: github (needs `GITHUB_PERSONAL_ACCESS_TOKEN`), brave-search (needs `BRAVE_API_KEY`), filesystem / git / sqlite (need paths in `mcp_preset_args`, e.g. `{"filesystem": ["D:/docs"], "git": ["D:/repo"], "sqlite": ["D:/data.db"]}`), puppeteer (downloads Chromium on first use). fetch, git, time and sqlite run via `uvx` (needs uv installed); the rest run via `npx` (needs Node.js installed). memory's knowledge graph is stored in `~/.nyra/memory.jsonl` by default (not in the npx cache, so clearing the cache doesn't lose it). Presets only provide configuration: MCP is off by default, and in `auto` mode each server is still confirmed one by one before it starts; a preset with a missing key or path is skipped with the reason stated. An entry with the same name in `mcp_servers` overrides the preset. github, brave-search, sqlite and puppeteer are servers officially archived upstream (no longer maintained), which is noted in the preset descriptions; sqlite only runs with `mcp 1.30.0` (newer SDKs removed the resources API).

**Pairing-code collaboration**: two Nyra instances can pair and work together. The host runs `nyra ui --pair`, and the terminal shows a 6-digit pairing code and a QR code (expires in 5 minutes, single use, void after 5 wrong attempts). The guest scans it with a phone (or opens the pairing link in a browser and enters the code); once paired, it sends tasks to the host, and the host runs them in read-only mode and sends the results back. Only text and results are exchanged, never credentials. Only pair on a network you trust (a home or office LAN), not on public Wi-Fi. Manage paired devices under **Settings → Phone** in the web interface (list, revoke), or via the API `GET /api/devices` / `POST /api/devices/<id>/revoke` (accepts only the computer-side launch token).

**Local vault**: when you don't want API keys in a config file or chat history, use the vault. `nyra vault init` sets a master password, and `nyra vault add DEEPSEEK_API_KEY` prompts for the key (not shown on screen or in command history). When Nyra later needs that key, it uses the environment variable if set, and otherwise fetches it from the vault automatically. The vault must be unlocked first; setting the environment variable `NYRA_VAULT_PASSWORD` unlocks it (only do this on your own machine). The vault file is `~/.nyra/vault.json`, stored encrypted so someone who gets the file can't open it; it is still not safe if the master password is weak or the machine itself is compromised, so use a dedicated password manager for high-value keys. `vault get` prints the plain text in your own terminal; only use it when you actually want to see it.

**Local knowledge base**: collect content from writers you like, articles and notes into a knowledge base, then ask it questions. Nyra answers only from what's in the base and says which notes it relied on; if the base doesn't have it, it says it doesn't know instead of making things up. All data is local in `~/.nyra/knowledge/<base name>/` (`kb.json` + `notes.jsonl`), implemented with the standard library and no third-party services:

```bash
nyra kb create jianghushuo --description "Personal growth, ways of working"
nyra kb add jianghushuo --file ~/docs/notes.md     # .txt/.md; --dir adds a whole folder
nyra kb add jianghushuo --url https://example.com/article   # fetch the article text from a page
nyra kb add jianghushuo --text "……" --title "Three core questions about making money"  # paste text directly
nyra kb search jianghushuo "What do you need to be clear about to make money"
nyra kb ask jianghushuo "What are the three core questions about making money?"
nyra kb list
```

When adding, text is split into notes by headings and blank lines (each up to about 1500 characters, with title, source and date). Search is local BM25 (Chinese and English tokenization), and questions go to the currently configured provider by default. Note: a Douyin video link alone doesn't give you the full transcript (the video page is rendered with JS, so Nyra only gets the title and description); to add a creator's videos to a base, paste the transcript/subtitle text first, or use an article link. Automatic use from the agent's main loop (looking things up in the base during chat) will be wired in after A–E are merged; for now use the command line.

**MCP launch environment isolation**: by default, MCP subprocesses are started with only the few system environment variables they need (such as `PATH`, `HOME`, Windows system paths) plus explicitly configured `env`; API keys such as DeepSeek/OpenAI are no longer passed through automatically. A server that really needs extra environment variables can declare them explicitly with `inherit_env` in its own config. Proxy variables with credentials stripped (`HTTP(S)_PROXY`, `ALL_PROXY`, `NO_PROXY`) and trusted-CA variables (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and so on) are also passed through, otherwise machines behind a corporate network or egress proxy couldn't download MCP servers on first use. Passwords embedded in proxy URLs are not passed; if your proxy requires authentication, declare the full URL explicitly in that server's `inherit_env`:

```json
{
  "mcp_enabled": true,
  "mcp_servers": {
    "example": {
      "command": "node",
      "args": ["server.js"],
      "inherit_env": ["EXAMPLE_API_KEY"],
      "env": {"EXAMPLE_MODE": "safe"}
    }
  }
}
```

`inherit_env` is an allow list of exact variable names and doesn't support `*`; explicit values in `env` take precedence. **This only reduces accidental credential leaks; it is not a process sandbox**: an MCP server can still access local files and the network as the current user, so only connect programs you trust.

**MCP process launch and tool approvals**: an MCP server may access local files and the network as soon as it starts. `readonly` and unattended `auto` don't start MCP; interactive `auto` in the terminal asks one by one whether each server may start, and every tool call still needs separate approval; `full` allows automatic start and calls. Switching `/mode` in the terminal first shuts down existing MCP subprocesses, then starts them under the new permissions. The web UI has no terminal launch-approval prompt, so `auto`/`readonly` modes don't start MCP there; MCP only starts once the web UI switches to `full`, and changing modes while a task is running is blocked. Note: this is only launch authorization, not an operating-system sandbox.

## Creation mode: build a plugin from one sentence

Creation mode (`creator`) lets you describe what you want in one sentence, and Nyra builds a plugin for you: it agrees on a spec first, then generates, then verifies, and only installs once you say yes. The idea comes from DeepSeek Harness's Creator Mode, but the implementation is different and safer: a Nyra plugin is skill files + a manifest (model-generated code is never run directly), it is always verified and always confirmed by you before installing, plugins get minimal permissions by default, and calls at run time still go through approvals and tool tiers.

Entry points: `nyra --mode creator`, `/creator` in interactive mode, and the mode picker on the web settings page (`nyra ui`).

```bash
nyra creator "make a pomodoro timer" --yes     # built-in template: 25-minute focus + 5-minute break, with a countdown panel
nyra creator "scan TODOs" --yes                # built-in template: scans the workspace for TODO/FIXME/XXX/HACK, summarized per file
nyra creator verify <staging folder>           # verify only, don't install
nyra creator install <staging folder>          # verify, then install (without --yes it shows the changes and asks you first)
```

The flow (every step leaves a record):

1. **Agree on a spec**: the one-sentence request is turned into a short spec saved to `.nyra/creator/<plugin name>/spec.md` in the workspace (goal, in/out of scope, skills, declared tools and permissions, how to verify, assumptions). It asks at most 2 questions about unclear key points; if they can't be answered, reasonable defaults go under "assumptions".
2. **Generate**: plugin files are written per the spec to `.nyra/creator/<plugin name>/staging/` (`plugin.json` + `skills/*.md`, with panels in `panel/*.html`). The pomodoro timer and TODO scan have built-in templates and are generated directly; for new requests the agent in the conversation writes the skill files using only tools Nyra already has.
3. **Verify**: `nyra creator verify` checks the manifest (skills and files match), parses skill frontmatter, requires declared tools to be known Nyra tools, and requires panels to be self-contained static pages (no external requests, no external scripts). If verification fails it fixes things; if it can't, it tells you so plainly and doesn't install.
4. **Confirm**: before installing it shows you exactly what will be installed: plugin name, version, new files, declared tools and permissions; high-privilege tools such as the shell, computer control and browser control are flagged separately with their risks. Nothing is installed until you say yes.
5. **Install and manage**: once installed it goes through the plugin marketplace (hash-locked; upgrades don't overwrite files you've changed). Disable: `nyra plugin disable <name>`; uninstall: `nyra plugin uninstall <name>`; view: `nyra plugin list`, `nyra --list-skills`.

Safety red lines: model-generated code always goes through the existing approval and trust system; plugins get minimal permissions by default and declare only the tools they actually use; a failed generation, a failed verification and your refusal are all reported plainly, with no bypassing and no retried installs. With no matching template and no model available (e.g. pure CLI without a model), `nyra creator` reports a readable error and installs nothing, rather than silently installing something broken.

## Interactive commands

Besides asking directly in interactive mode, you can use:

| Command | What it does |
|---|---|
| `/help` | Show help |
| `/mode <mode>` | Switch approval mode |
| `/creator` | Enter creation mode |
| `/skills` | List loaded skills |
| `/sessions` | List past sessions |
| `/compact` | Compact the current session (model summary + recent messages kept) |
| `/clear` | Clear the current conversation history |
| `/new` | Start a new session |
| `/exit` or `/quit` | Quit |

Continue a previous session: `nyra --resume <session id> "continue"`.

## Terminal interface (interactive mode)

Run `nyra` in a terminal to enter interactive mode. The interface has four parts:

1. **Startup header**: on the left, a small 4-line Nyra mark (a cursor engraved in a solid circle); on the right, three lines: `Nyra v<version>`, `<model> · <provider> · <billing>` (API billing / local model / CLI login) and the current working folder. When the terminal is narrower than 60 columns, only the three lines on the right are shown.
2. **Workspace trust prompt**: the first time you run it in a folder, it asks ("正在访问工作区：", "accessing workspace:") whether this folder is a project you created or trust, since Nyra can read, modify and run files there. Choose with the arrow keys or the numbers `1` / `2`, Enter to confirm, Esc to cancel:
   - `1. 是，我信任这个文件夹` ("Yes, I trust this folder"): remembers this folder (`~/.nyra/trusted_workspaces.json`, one entry per absolute path, covering only this folder itself, not subfolders or parents) and won't ask here again;
   - `2. 否，退出` ("No, quit"; Esc and Ctrl+C also count as "no"): Nyra exits right away and records nothing.
   Trust only decides whether Nyra may start here; it **doesn't loosen the approval mode**: readonly / auto / full rules apply as before. To skip the prompt: add `--trust` (trusts and records the current folder), or set `"skip_workspace_trust": true` in `~/.nyra/config.json`. Non-interactive runs (stdin or stdout isn't a terminal, `--json`, scheduled tasks, task queue worker) never prompt and behave as before.
3. **Input box**: a `> ` input line between two horizontal rules that follow the terminal width. Left/right / Home / End move the cursor, up/down browse history, Ctrl+U clears to the start of the line, Ctrl+K clears to the end, Ctrl+W deletes a word, Ctrl+L clears the screen; Ctrl+C clears the input when there's text, and Ctrl+C or Ctrl+D quits on an empty line. Input wider than the box scrolls horizontally, and Chinese characters count as two columns.
4. **Status bar** (below the input box):
   - `[model] │ project name` (the project name is the working folder's name; in the home folder it shows the user name);
   - `上下文 N%` (context N%): the most recent request's input tokens ÷ the configured context window (`--context-window` or `context_window_tokens` in the config). If either number is unknown it isn't shown, and nothing is estimated;
   - the current approval mode, e.g. `›› auto 逐项确认（shift+tab 切换）` ("auto, confirm each step (shift+tab to switch)"). **shift+tab** cycles readonly → auto → full → readonly. Going from auto to full takes two presses: the first only shows a red warning ("press shift+tab again to enter full"), and any other key cancels; while in full, the whole line shows a red notice ("full access: file writes and commands are no longer confirmed one by one"). Switching with shift+tab is exactly the same as `/mode` (it also restarts MCP subprocesses and clears this session's per-item approvals).
   Reasoning effort, plan mode and similar states aren't supported by the interactive core yet, so they aren't shown.

Interface text is Chinese by default; set `"language": "en"` in `~/.nyra/config.json` or the environment variable `NYRA_LANG=en` to switch to English. Colors are black and white with a few accents (model in cyan, project and headings in gold, full in red); setting `NO_COLOR=1` removes only the colors and keeps the layout.

**Automatic plain-text fallback**: when stdin or stdout isn't a terminal, `TERM=dumb`, the Windows console doesn't support ANSI (VT) sequences, or `NYRA_TUI=0` is set, interactive mode falls back to the original plain-text interface: a NYRA wordmark banner (version, model, approval mode, session id), a status line above the prompt `[model] | folder · 上下文 n% · mode` (`--` when the context is unknown), the prompt `nyra[auto] ›`, and `/mode` to switch modes. When the terminal encoding can't display block characters (e.g. old code pages), it switches to ASCII lines and mark automatically.

**Cross-platform**: macOS / Linux read keys with the standard `termios`, and Windows (PowerShell, Windows Terminal, cmd) uses `msvcrt` and turns on the console's VT mode; zero third-party dependencies.

Every tool call is shown grouped as `┌ tool name arguments` / `└ ✓/✗ result summary`. The output of one-off tasks (`nyra "task"`) is unchanged; the first time you run a one-off task in a folder from a terminal, it also asks for trust first.

## Custom commands and /init

Save prompts you use often as command files and call them with a slash any time, instead of retyping them:

```bash
# User level: ~/.nyra/commands/review.md
# Project level: <working folder>/.nyra/commands/review.md (project level wins on a name clash)
```

Files are Markdown and may have frontmatter (`description:`, `argument-hint:`); the body is the prompt template sent to the model. `$ARGUMENTS` is replaced with everything typed after the command, and `$1`, `$2`… with the 1st, 2nd… word; if the body has no placeholders, the arguments are appended to the end of the body. Example `review.md`:

```markdown
---
description: Review code and list problems
argument-hint: <file>
---
Review the following code and list the problems: $ARGUMENTS
```

Use it in the REPL: `/review src/main.py`. `/commands` lists the custom commands currently available (with their source: project or user level). Built-in commands take precedence over custom commands with the same name; command files are only prompts and can't run code, read files or change settings on their own; symlinked command files are skipped.

`/init` creates a starter `AGENTS.md` template in the current working folder (four sections: project overview, common commands, conventions, caveats, with hints on what to fill in). An existing `AGENTS.md` isn't overwritten. The write goes through the normal `write_file` tool, so it needs approval and respects the working-folder boundary and checkpoints; it is refused in readonly mode.

## Web interface

```bash
nyra ui            # prints a link with a token after starting; open it in a browser
nyra ui --open     # opens the browser automatically
nyra ui --port 9000 --workdir ~/project --mode auto
```

A local web interface: a plain standard-library `http.server` plus one embedded HTML/CSS/JS page, with no CDN or external resources. Desktop v2 (minimal black and white, 2026-11-18, built from the finalized macOS / Windows designs; light/dark follows the system; Latin subsets of the Inter / JetBrains Mono fonts are bundled, and Chinese uses system fonts):

- **Left sidebar**: new session (Ctrl/⌘ + Shift + O), search sessions (Ctrl/⌘ + K, filters session titles), entries for Skills & tools / Scheduled tasks / Bot group chat / Long-term memory, with Settings at the bottom. Sessions are **grouped by project**: each session run from the web interface records its working folder (`~/.nyra/sessions/ui-projects.json`), with the current project first; sessions left by the command line or older versions have no project information and are listed honestly under "Other sessions", without guessing.
- **Conversation**: user bubbles and Nyra's replies (basic Markdown). Tool calls are combined into a collapsible group of step rows ("read auth/client.py", "search "http.post"", "run …"); open a row to see arguments and results. While running it shows "working · Ns", and when done "worked Ns · N steps" (times come from this run's event timestamps; when reading a past session, only the most recent run is timed). When a turn changes files, a changed-files card (path + lines added/removed) appears after the reply; click it to jump to the changes panel on the right.
- **Approval cards**: in auto mode they appear in the conversation before a file write or command. The title is the action, with the real diff at approval time below it; the buttons are "Reject / Always allow for this session / Allow once". "Always allow for this session" has the same scope as `a` in the terminal: it only applies to the same kind of tool on the same file (`write_file` / `edit_file` / `plan`), or the exact same command + folder + timeout (`shell`); other tools don't show this button. The grant lives only in this session's memory and isn't shared with the terminal's cached grants. A request left unanswered for 10 minutes is treated as rejected.
- **Input box at the bottom**: approval-mode switch (read-only / approve each step / full access; can't be changed while a task runs), model picker (calls `POST /api/provider`; takes effect for new sessions, existing sessions keep their model), and a **plan mode** toggle: when on, tasks you send go through the same read-only planning as `nyra --plan` (only `read_file` / `list_dir`, only writes `plan.md`), and a plan card with its SHA-256 appears in the conversation. Clicking "Execute plan" runs it by that checksum (refused if `plan.md` has been changed; can't run in read-only mode), and execution still confirms each step according to the current approval mode.
- **Top bar and status bar**: session title, run status (idle / running / waiting for approval / error), "worked Ns", this session's token usage (in / out, hidden when the model doesn't report it); the status bar shows the working folder, mode, context usage (estimated from the most recent input tokens) and MCP status.
- **Review panel (right side, Ctrl/⌘ + .)**: Changes (the diff of every file changed in this session: with an approval preview it uses the real diff and line numbers from approval time; when reading a past session it's reconstructed from tool arguments, and `edit_file` can only show the replaced text without line numbers), Plan (the most recent `plan` tool call), Evidence (sources fetched online), Terminal (commands and output of this session's `shell` tool), Artifacts (code / HTML; HTML is rendered only in a sandboxed iframe), Usage (token details, number of automatic compactions). On narrow screens the panel becomes an overlay, closed with Esc.
- **Settings page**: provider dropdown + model input + "Apply"; three-way approval-mode switch; the API key table only shows environment variable names and whether each is configured. Keys can only be set through environment variables in the terminal that starts `nyra ui`, followed by a restart; the page never takes, shows or saves keys. The run configuration is read-only.
- **Skills & tools / Scheduled tasks / Bot group chat**: as before: an overview of skills and built-in tools; view, start/stop and delete scheduled tasks (creating them from the web page isn't open yet; use `nyra schedule add`); the group chat list and the entry to the separate `/groups` page (`?room=<id>` goes straight to a room).
- **Usability**: works at a 390px phone width (sidebar drawer, full-screen panel overlay); fully keyboard operable (tab order, left/right arrows to switch review-panel tabs, focus outlines); all animation is off with `prefers-reduced-motion`; the web page has no intro animation. Things in the designs that the core doesn't support yet (line-by-line diff comments, commit / open-in-editor buttons, cloud computers, live terminal input) are not shown as fake buttons.

About the screenshots: the top of the README shows real screenshots of the v0.5.5 web interface and mobile page (example sessions run with local test fixtures). At desktop width the layout is "sidebar + conversation + right drawer", with drawer tabs Overview / Changes / Plan / Evidence / Terminal; the approval card buttons are "No, try another way / Allow once", and "More" contains always allow for this session and remember as a rule.

Security: it only listens on `127.0.0.1` by default (a warning is printed if `--host` is set to a non-local address). Each start generates a random access token, passed in the page link via `?token=`, and every API request must carry it in a header (CSRF protection); when listening on a local address, the `Host` header is also checked. This computer-side token is only accepted from local (loopback) connections: when listening on the LAN with `--pair` / `--host`, another host holding it gets nothing; phones use their own device tokens from pairing. The web interface runs tools locally and starts MCP servers according to the config (off by default).

### Phone (PWA + QR pairing)

```bash
nyra ui --pair     # listens on the LAN and shows a pairing QR code in the terminal
```

After scanning (or opening `http://<computer IP>:8765/m` in the phone's browser and entering the 6-digit pairing code), the one-time pairing code is exchanged for a long-lived token for this phone, and you can then "Add to Home Screen" to use it like an app: session list, conversation, sending tasks, big "Allow once / Always allow for this session / Reject" buttons on approval cards, and diffs you can swipe sideways. When something is waiting for approval the title becomes `(1) Nyra`, and on supported systems the icon shows a badge (local, not push). You can also start normally without `--pair` and click "Connect a phone" under **Settings → Phone** to show the code (as long as the LAN is being listened on via `--pair` or `--host`); the same place lists paired phones and lets you revoke them.

- Security: still binds only to `127.0.0.1` by default; pairing codes are 6 digits, valid for 5 minutes, single use, void after 5 wrong attempts; `~/.nyra/devices.json` stores only SHA-256 hashes of tokens; a phone token can't pair or revoke devices; the CSP isn't loosened; it's plain HTTP, so only use it on trusted Wi-Fi and never expose it to the internet.
- The intro animation only plays when launched from the phone's home screen as a standalone window (once per cold start, about 3 seconds, tap to skip, logo fade-in only with "reduce motion"); the desktop web page, mobile browser tabs and the website don't play it. The system launch screen and the animation's first frame are both `#0B0B0C`, so there's no white flash.
- Plainly: it has only been tested with Playwright emulating an iPhone 14 / Pixel 7, not installed on a real device. Android Chrome may only create a shortcut for an http LAN address (opens as a tab, no animation); an iPhone home-screen app may keep storage separate from Safari, so you may need to enter the pairing code again in the app. Full steps are in [docs/mobile-pwa.md](docs/mobile-pwa.md).

### Desktop app (Tauri shell, preview)

`desktop/` is the source of the macOS / Windows desktop app: Tauri 2 (Rust + the system WebView), with no bundled browser engine. When opened, it looks for the Nyra binary on this machine (`NYRA_BIN` environment variable → `nyra` / `nyra.exe` on `PATH` → `~/.local/share/nyra/nyra[.exe]` → `~/.local/bin/nyra[.exe]` → `~/nyra/nyra[.exe]`) and runs it in the background:

```bash
nyra ui --host 127.0.0.1 --port 0 --print-url-json --exit-on-stdin-close --workdir ~/Nyra
```

- `--print-url-json`: prints one line of JSON (`nyra`, `version`, `url`, `host`, `port`, `token`) as the first line of stdout, with other messages moved to stderr, so the shell can read the address. That line contains the token; like the printed link, don't share it.
- `--exit-on-stdin-close`: stops the server when stdin closes (no background process is left behind after the shell quits or crashes).
- The window only shows the built-in welcome page and this launch's `http://127.0.0.1:<port>`; other links open in the system browser. The web interface's CSP and token authentication are unchanged, the web page can't reach Tauri's native APIs, and the desktop app doesn't play the intro animation.
- If the Nyra binary isn't found, it shows install instructions and a "Detect again" button. The working folder defaults to `~/Nyra` (change it with `NYRA_DESKTOP_WORKDIR`); when opened from the Dock on macOS, it reads the login shell environment once to pick up `PATH` and API keys from `~/.zshrc`.
- Installers are built by `.github/workflows/desktop.yml` on macos-latest (universal `.dmg`) and windows-latest (`.msi` + NSIS `-setup.exe`), only on manual runs or `v*` tag pushes. The output is workflow artifacts, **unsigned**: on macOS right-click → "Open" or run `xattr -dr com.apple.quarantine /Applications/Nyra.app`; on Windows SmartScreen click "More info → Run anyway". Details in [docs/desktop.md](docs/desktop.md).

## Skills

Skills are `skills/*.md` files (four examples are included: `web-research` for online research, `file-organizer` for tidying files, `verify-research` for fact-checked research, `deep-thinking` for ten questions of deep thinking), in this format:

```markdown
---
name: web-research
description: Search the web and verify information
when: Use when you need up-to-date information
keywords: search, look up, latest
---
Instructions for the agent go here…
```

Nyra automatically loads the most relevant skills based on the task's keywords. Your own skills are stored in `~/.nyra/skills/`. When a task is done and the approach is worth reusing, Nyra saves it as a new skill with the `save_skill` tool.

## Tools

Nyra has 47 built-in tools (`TOOL_SCHEMAS`; tests check this number): files and code `read_file`, `write_file`, `edit_file`, `apply_patch`, `list_dir`, `grep_search`, `git_status`, `lsp_diagnostics`, `lsp_symbols`, `editor_context`; commands `shell` (with a blocklist of dangerous commands); network `web_fetch`, `web_search`, `http_post`, `multi_model_research` (parallel research across several models); browser `browser_navigate` / `browser_click` / `browser_screenshot` (CDP); computer control `computer_screenshot` / `computer_click` / `computer_type` / `computer_key` / `computer_windows` (all require approval); media and documents `describe_image`, `media_ingest`, `export_office`; memory and search `memory_append`, `memory_search`, `memory_forget`, `memory_delete`, `knowledge_search`, `session_search`, `usage` (check your remaining usage); connectors `gmail_search` / `gmail_read` / `gmail_send`, `shopify_products` / `shopify_orders` / `shopify_inventory`, `slack_channels` / `slack_history` / `slack_send` (off by default, only available once an account is connected; sending requires approval); skills and collaboration `save_skill`, `read_skill`, `delegate` (sub-agent), `delegate_parallel`, `plan` (write a plan first, then execute). There are also 3 opt-in Poppy tools, off by default and enabled explicitly: `poppy_discover`, `poppy_identity_check`, `poppy_permission_check` (public protocol discovery and local permission-intent checks only; no sign-in, no transactions), not counted in the 47 above.

- **plan**: for multi-step tasks, write a plan file first (`plan.md` by default), then execute.
- **delegate**: hand a subtask to a sub-agent (with a limited number of turns), get a summary back and continue.
- **memory**: long-term memory is in `~/.nyra/MEMORY.md`; project notes are read from `AGENTS.md` in the working folder (as Codex does).
- **sessions**: every run is saved automatically to `~/.nyra/sessions/<id>.jsonl` and can be continued with `--resume`.

- **Evidence trail**: page text fetched online is stored in `~/.nyra/evidence/<session id>/`, and information cited from the web includes source links; fact-checking tasks use the `verify-research` skill (search → open the official site → check item by item → save evidence → deliver with links).
- **MCP**: off by default; available after setting `"mcp_enabled": true` and configuring `mcp_servers` in `~/.nyra/config.json`. `nyra --list-mcp` shows the loaded tools. Timeouts on stdio pipes are handled on Windows/Linux/macOS.
- **Windows terminal encoding**: when an old code page can't represent Chinese, the CLI/scheduler shows `\\uXXXX` escapes instead of crashing. Use a UTF-8 terminal (e.g. run `chcp 65001` first in PowerShell) to display Chinese directly.
- **Scheduler**: `nyra schedule list/add/remove/run/daemon`, see `nyra schedule --help`.
- **Session compaction**: `nyra --compact <session id>` or `/compact` in the REPL.
- **E2B sandbox** (in 0.3.0, removed in 0.4.0): in 0.3.0, file reads/writes and shell commands could run inside an E2B sandbox without touching the local machine. It was removed together with Python in 0.4.0; the Node E2B backend hasn't been ported yet, `--sandbox e2b` now fails with an error, and only `--sandbox local` is supported. The sandbox-mode rules for working folder, expiry and `--sandbox-timeout` went away with the feature and no longer apply.

## Tests

```bash
bun test tests/node   # full Node test suite, all mocked, no key needed
bun x tsc -p tsconfig.json --noEmit   # type check
```

Records of real-API end-to-end tests are in [VERIFICATION.md](VERIFICATION.md).

## Project layout

```
├── src/               Node runtime (the only implementation since 0.5.1, packed into a single-file binary with Bun --compile)
│   ├── cli.ts         entry point: argument parsing + interactive REPL + all subcommands
│   ├── agent.ts       agent main loop (plan → tool calls → report) + mode switching (incl. creation-mode skill)
│   ├── tools.ts       47 tools + approvals + shell blocklist
│   ├── providers.ts   OpenAI-compatible client + automatic model fallback + multi-key rotation per model + 14 presets
│   ├── gateway.ts     local web interface server (nyra ui, incl. group chat page, mode switching, creation mode)
│   ├── webuiPage.ts   embedded single page of the web interface (HTML/CSS/JS, incl. mode picker)
│   ├── creator.ts     creation mode: one-sentence request → spec → generate plugin → verify → install after confirmation
│   ├── plugins.ts     minimal plugin marketplace: skill-pack install, hash locking, upgrade protection, lifecycle
│   ├── computer.ts    computer control: three backends (Linux x11 / Windows PowerShell / macOS)
│   ├── cdpBrowser.ts  CDP browser client (connects only to local Chrome)
│   ├── vision.ts      screen viewing with vision models: image-part assembly + vision capability check
│   ├── groups.ts      multi-bot group chats: file-based rooms, @mention routing, separate keys per bot
│   ├── poppy.ts       Poppy 1.0 public protocol discovery + site permission-intent ledger
│   ├── eigenflux.ts / eigenfluxPolicy.ts  EigenFlux bare-CLI diagnostics and local network permission limits
│   ├── knowledge.ts   local knowledge base (BM25) + worker pool
│   ├── skills.ts      skill loading / matching / saving (incl. parseSkillText)
│   ├── vault.ts       local encrypted vault (PBKDF2, stores provider API keys)
│   ├── pairing.ts     pairing-code collaboration: 6-digit code pairing, device registry
│   ├── memory.ts / memoryExchange.ts / memoryBrowser.ts  long-term memory + memory exchange + memory browser
│   ├── scheduler.ts / tasks.ts  built-in scheduler + background task queue
│   ├── checkpoints.ts / rewind.ts  checkpoints before writes, /undo and /rewind
│   ├── planMode.ts / jsonMode.ts  two-phase plan mode / non-interactive JSON Lines output
│   ├── mcp.ts / mcpPresets.ts / mcpCost.ts  MCP client, built-in presets, cost cap
│   ├── smartApprovals.ts / approvalUi.ts  smart approvals + terminal approval picker
│   ├── compact.ts / runs.ts / usage.ts / evidence.ts / citations.ts  session compaction, run records, usage, evidence trail
│   ├── consoleUi.ts / banner.ts / doctor.ts / wizard.ts / exampleTask.ts / noKey.ts  terminal interface, banner, self-check, wizard, example, no-key notice
│   ├── config.ts / migration.ts / trust (see migration.ts) / net.ts / untrusted.ts / multiModel.ts  config, migration, network, injection defense, multi-model research
│   └── assets/        group chat page (group_ui.html.txt / group-ui.js.txt, bundled into the binary)
├── skills/            bundled skills (incl. creator-mode, deep-thinking, debugging, etc.)
├── tests/node/        Node tests (bun test tests/node, mock-only, no key needed)
├── scripts/           build-binaries.sh (Bun --compile for 5 platforms), install-node.sh / install-node-macos.sh / install-node.ps1 (one-line install per platform), build-package-node.sh (Linux tarball / .deb), check-budgets.sh (startup/memory budgets), probes/ (Bun API compatibility probes)
├── desktop/           Tauri desktop shell (lib.rs finds the Node binary and starts nyra ui) + welcome page ui/
├── systemd/ / launchd/  service files for the scheduler daemon (call the nyra binary)
├── docs/              project website (GitHub Pages, plain static) and install/migration docs
├── .github/workflows/ node-ci.yml (tsc + tests on three platforms + budgets), node-binaries.yml (publishes Releases), desktop.yml
├── README.md / DESIGN.md / GUIDE.md / VERIFICATION.md / CHANGELOG.md / ROADMAP.md
├── package.json / bun.lock / tsconfig.json
└── LICENSE            MIT
```

## Roadmap

The consolidated list of items still to build (details in [DESIGN.md](DESIGN.md) and [ROADMAP.md](ROADMAP.md); implemented items are no longer listed):

- **Real sandbox**: run the shell with bubblewrap or a uid sandbox on Linux and limit writes to the working folder. Commands currently still run as the user running Nyra, so only use full mode in folders you trust.
- **Browser tools**: implemented (`src/cdpBrowser.ts`, connecting directly to local Chrome's CDP over the global WebSocket: BrowserNavigate / BrowserClick / BrowserScreenshot, without a Playwright/Chromium driver); plain-text fetching with `web_fetch` is kept as a read-only path.
- **Reliability queue**: resumable long tasks + self-verified results, cost caps and a live cost dashboard, a real status board for multiple agents.
- **Poppy**: P4 (UCP shopping and conversations with store agents), P5 (Nyra publishing its own capabilities); P3's real sessions, OAuth sign-in, DPoP and HTTP MCP are not implemented either.
- **EigenFlux**: E2 (user-approved install and network onboarding), E3 (inbox, feed, subscriptions and public broadcasts), E4 (multi-bot collaboration matching).
- **Tier 1**: hooks (pre/post hooks), Telegram gateway.
- **Tier 2**: streaming output, image input, full-text session search, parallel sub-agents, a Nyra MCP server, HTTP MCP, editor integrations.
- **Service mode, step 2**: user-to-sandbox mapping + persistent volumes (step 1, a single-user E2B prototype, is done).
- **Other**: wiring the knowledge base into the agent main loop (command line only for now), GEPA-style automatic learning, signing for the desktop app, auto-update (unsigned preview installers can already be built in CI, see docs/desktop.md), concurrent sessions.
