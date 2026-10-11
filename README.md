# x-premium-cli

Use Grok chat, official `x_search`, and `web_search` from Codex CLI and Claude Code through a shared Skill.

Uses X Premium OAuth subscription access only. No API keys, pay-as-you-go API, or prepaid credits. Paid billing checks remain mandatory; quota checks are optional.

The [search tool is provided by xAI](https://docs.x.ai/developers/tools/x-search); this integration is unofficial. No npm dependencies or background server.

## Install

Requires macOS Apple Silicon and Node.js 22+. Run from the repository root:

```bash
node skills/x-premium-cli/x-premium-cli.mjs setup
node skills/x-premium-cli/x-premium-cli.mjs login

mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills"
ln -s "$PWD/skills/x-premium-cli" "$HOME/.agents/skills/x-premium-cli"
ln -s "$PWD/skills/x-premium-cli" "$HOME/.claude/skills/x-premium-cli"
```

Complete sign-in in the official browser page. Setup downloads the official CLI (~168 MB) once and verifies its pinned hash and xAI signature. The binary stays in `~/.cache/x-premium-cli/`; credentials stay in `~/.local/share/x-premium-cli/auth/`.

### Codex plugin

Alternatively, install the same Skill as a Codex plugin:

```bash
codex plugin marketplace add ryokobachan/x-premium-cli
codex plugin add x-premium-cli@x-premium-cli
```

Invoke `$x-premium-cli:x-premium-cli` in a new Codex chat. The plugin only packages the existing Skill; it uses the same setup, OAuth credentials, and subscription checks.

## Use

Ask your agent to use `x-premium-cli`, or run directly:

```bash
node skills/x-premium-cli/x-premium-cli.mjs chat "Hello"
node skills/x-premium-cli/x-premium-cli.mjs x-search "Find two recent OpenAIDevs posts with URLs"
node skills/x-premium-cli/x-premium-cli.mjs web-search "Find the latest official xAI announcement"
```

Use `status` only when you want quota and billing information, `models` for available models, and `paths` for storage locations. Missing quota information does not block requests. Subscription-limit errors stop the request without retries or paid fallback. Run `login` yourself when authentication expires; agents must not launch or control a browser for X workflows. Timestamps derived from post IDs are marked as unverified.

Local tests: `node --test tests/x-premium-cli.test.mjs`.
