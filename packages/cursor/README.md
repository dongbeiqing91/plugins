# @magpie-community/opencode-cursor-auth

Signs in to a [Cursor](https://cursor.com) subscription (Pro, Pro+, Ultra,
Teams) and makes its requests on the API `cursor-agent` talks to, in
OpenCode and in magpie. Provider id: `cursor`.

## Signing in

An account is a Cursor access token. There are three ways to get one:

- **Cursor (browser)**: the sign-in `cursor-agent login` does. The page
  `cursor.com/loginDeepControl` is opened with a PKCE challenge, and the
  plugin polls `api2.cursor.sh/auth/poll` until the browser has signed in.
  The account is named by its email (`DashboardService/GetMe`).
- **cursor-agent's sign-in**: takes the account `cursor-agent login`
  signed in to. Its token is read on every request from where the CLI
  keeps it: the macOS keychain (`cursor-access-token`), else its
  `auth.json` (`~/.cursor/`, `$XDG_CONFIG_HOME/cursor/` or
  `%APPDATA%\Cursor\`). The plugin never writes it; when it has less than
  5 minutes left, `cursor-agent status` is run, which renews it.
- **Cursor API key**: a key from cursor.com/dashboard → Integrations. It is
  exchanged for a token at `/auth/exchange_user_api_key`, as the CLI does
  with `CURSOR_API_KEY`, and exchanged again when the token runs out.

Sign-ins are kept where OpenCode keeps them (`auth.json`; in magpie,
`plugin-auth.json`). A browser sign-in's token lasts about two months.
Cursor gives the CLI no way to renew it, so after that you sign in again.

## Requests

OpenCode speaks chat completions (`@ai-sdk/openai-compatible`); the
plugin's `fetch` answers them on Cursor's agent API:

- The agent API is the one `ServerConfigService/GetServerConfig` names for
  the account (a team may be served in one region only), else
  `agentn.global.api5.cursor.sh`. A refusal that names a region is tried
  once more with the config asked again.
- Each request is one `agent.v1.AgentService/Run`, a Connect stream both
  ways over HTTP/2, with the CLI's headers (`x-cursor-client-type: cli`,
  its version, privacy mode on).
- HTTP/1.1 is Cursor's Network setting "HTTP Compatibility Mode". Give the
  plugin `{ "http": "1.1" }` (`magpie plugin options` of this package, or
  `provider.cursor.options.http` in OpenCode), or set `CURSOR_HTTP=1.1`.
  A Run then goes as `AgentService/RunSSE` (the server's stream, carrying
  only a request id) and one `BidiService/BidiAppend` per message the
  client sends, both to `api2.cursor.sh`. The agent host named for HTTP/2
  resets these. Both are ordinary HTTP/1.1, which a proxy that breaks
  HTTP/2 can carry. HTTP/2 stays the default.
- The whole conversation goes each time, as AI SDK messages kept as blobs
  the server asks for. The caller's tools are MCP tools, listed in the
  system prompt; the model calls them through Cursor's `CallDynamicTool`,
  and the calls come back as chat completion tool calls. Cursor's own tools
  (shell, file reads, edits) are never run.
- A conversation's Runs share one `conversation_id`, so Cursor sends them
  to the machine that has the prompt cached (Grok on Cursor caches by
  machine). It is made from what names the session — the request's
  `prompt_cache_key` (Codex's thread id), else the session the
  `chat.headers` hook is told — and the conversation's first user message,
  so subagents under one session are conversations of their own. With
  nothing naming the session, each Run has a new one.
- Text, thinking (`reasoning_content`) and token usage come back streamed
  or not. Cursor's `input_tokens` counts the cached prompt too: the cache
  read and written is taken out of it, and given as `cached_tokens` and
  `cache_write_tokens`, so it is counted once; its reasoning tokens are
  `reasoning_tokens`. A step that calls tools gets no usage in its Run
  (Cursor tells it only once the tools' results come back in the same
  Run), so once the Run is closed its usage is read from the dashboard's
  usage events, by the Run's conversation id: it shows in about 2.5 s,
  and is looked for up to 6 s. Far from Cursor it shows later than that
  (yetone/magpie#1053), so the step says 0 used and the conversation owes
  it: its next steps collect the event in the background and count it
  with their own, and a step that ends the turn waits for what is still
  owed, so the conversation adds up to what Cursor counted. An account
  whose events miss the wait 3 steps in a row stops waiting for them.
  With nothing naming the session (so no later step to collect it), or
  an account that can't read its usage events, the step is estimated as
  before.
  Failures keep their statuses: 401 to sign in again, 429 at the
  usage limit, 400 for a prompt too long, 403 for a region refusal.

## Models

The `config` hook declares `auto` (Cursor's pick). Once signed in, the
`provider.models` hook lists the account's models
(`AgentService/GetUsableModels`, cached 10 minutes), by the ids
`cursor-agent models` shows:

- Cursor lists a model once per effort (`gpt-5.6-low`, `gpt-5.6-high`, …).
  Each family is one model here, with the efforts as variants; the
  request's `reasoning_effort` picks the id, fitted to the nearest one there
  is. `-fast` and `-thinking` models stay models of their own; a
  `service_tier` of `priority` picks the fast one.
- The context window is 1M for a model whose name says 1M, else 200K.
- Cursor's model picker (`AiService/AvailableModels`, as the CLI asks for
  it) adds the models it offers that the usable list leaves out (GLM-5.3,
  GLM-5.3 Flash), run with the picker variant's parameters; hidden and
  Tab-only models stay out.
- A model Cursor serves only in Max Mode (the usable list's `maxMode`, a
  picker model with no other mode, or a Max Mode variant) is asked for in
  Max Mode, as the CLI turns it on for one. A model neither says it of is
  asked again in Max Mode when Cursor answers "Max Mode Required", and so
  from then on.

## Not included

- Usage and plan limits.
- Web search: Cursor's own web search is refused like its other tools.
- Switching between several accounts. OpenCode keeps one sign-in per
  provider.
- The Responses and Messages APIs: only chat completions are answered.
