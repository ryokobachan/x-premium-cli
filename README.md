# x-premium-cli

Use Grok chat, official `x_search`, and `web_search` from Codex CLI and Claude Code through a shared Skill.

Uses X Premium OAuth subscription access only. No API keys, pay-as-you-go API, or prepaid credits. Requests stop when quota or billing status cannot be verified.

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

## Use

Ask your agent to use `x-premium-cli`, or run directly:

```bash
node skills/x-premium-cli/x-premium-cli.mjs chat "Hello"
node skills/x-premium-cli/x-premium-cli.mjs x-search "Find two recent OpenAIDevs posts with URLs"
node skills/x-premium-cli/x-premium-cli.mjs web-search "Find the latest official xAI announcement"
```

Use `status` for quota and billing checks, `models` for available models, and `paths` for storage locations. Run `login` again when authentication expires. Timestamps derived from post IDs are marked as unverified.

Local tests: `node --test tests/x-premium-cli.test.mjs`.
