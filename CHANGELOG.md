# Changelog

## Unreleased

- Color tagged JSON separators with the editor foreground and matched bracket pairs with the VS Code theme bracket palette, respecting `editor.bracketPairColorization.enabled`.
- Color `/*markdown` bodies in the C# editor like a `.md` file (headings, emphasis, inline code, links, lists, quotes, fenced code, inline HTML, strikethrough), using the bundled Light+/Dark+ colors. Plain text now uses the editor foreground instead of the comment color. This applies when color decorations are active (`dotnetFileAppsToolkit.comments.highlight.strategy` = `decorations`, or `auto` with C# semantic highlighting).

## 0.2.0

- Add tagged-comment support for JavaScript, TypeScript, HTML, CSS, Python, C++, TOML, INI, Dockerfile, and CSV.
- Add opt-in YAML/JSON validation diagnostics and structure previews (`dotnetFileAppsToolkit.comments.validation.enabled`).
- Add Copy Tagged Comment Body and Extract Tagged Comment to File… (with confirmation); embedded content is never executed.
- Add Pack as Tool, Clean File-Based App Cache… (with confirmation), and Run with Launch Profile….
- Add Manage File-Based App Directives… to add or update `#:package` and inspect or edit `#:sdk`, `#:property`, `#:project`, and `#:include`.
- Add .NET 11 SDK-gated Manage Project References… and Format File….
- Add optional CodeLens for the entry point and tagged comments (`dotnetFileAppsToolkit.codeLens.enabled`, off by default).
- Security: Check .NET SDK now requires a trusted workspace, because `global.json` `sdk.paths` can select an SDK inside the workspace.
- Add a Restricted Mode integration test suite that runs in an untrusted workspace.

## 0.1.0

- Add .NET file-based app detection and commands for run, run with arguments, restore, build, clean, publish, and convert to project.
- Add SDK selection checks, workspace trust handling, task support, and per-file enable/disable actions.
- Recognize explicitly tagged C# block comments with Markdown hover/preview and syntax-highlighted code previews.
- Add TextMate injection grammar and a decoration fallback for tagged code in C# editors.
- Add English and Traditional Chinese localization.
