# .NET File Apps Toolkit — Development Plan

> VS Code extension ID (proposed): `dotnet-file-apps-toolkit`  
> Target: .NET SDK 10+ file-based applications (`*.cs`)  
> Language: TypeScript | Runtime: VS Code Extension Host (Node.js)  
> Status: Revised implementation plan (language-tagged comment blocks; not an implemented extension)

## 1. Product goal

Provide a focused VS Code experience for developing .NET file-based apps without a `.csproj`:

1. Recognize explicitly **language-tagged C# block comments** such as `/*markdown ... */`, `/*yaml ... */`, and `/*json ... */`; apply language-appropriate rendering/highlighting without modifying `.cs` source.
2. Use a **rich document renderer** for Markdown and **syntax-highlighted source presentation** for YAML, JSON, SQL, and other supported languages. Provide an optional synchronized preview in an adjacent editor.
3. Add context-sensitive editor title actions for running, restoring, converting, and previewing the current file.
4. Expose other official .NET file-based app CLI operations through an Actions picker / Command Palette.
5. Preserve the stock VS Code C# editor, IntelliSense, formatting, debugging integrations, and undo/redo behavior.

**Non-goals (MVP):** replacing the C# editor; implementing a new C# language server/debugger; editing `.csproj` directly; inferring that every `.cs` is independently executable; magically turning the native C# editor into a WYSIWYG HTML renderer; executing or evaluating code from tagged comments; implementing embedded-language IntelliSense, language servers, or arbitrary user-defined grammars in the first release.

Tagged-comment visualizations are **read-only presentation features**. They do not change C# runtime semantics.

## 2. Feasibility, syntax contract, and user experience

### 2.1 Explicit language tags (replaces the earlier `/** ... */` rule)

Only an actual C# block-comment token **beginning immediately with** `/*<language>` is eligible. A recognized tag must be followed by a line break or whitespace separator, and the comment closes with the ordinary `*/`. Language IDs are case-insensitive and normalized through a finite alias registry.

```csharp
/*markdown
# Inventory Utility

This application validates **inventory** files.

- Run with `dotnet run --file inventory.cs`
- Supports JSON input
*/

/*yaml
name: inventory-app
environment: production
features:
  - validate
  - export
*/

/*json
{
  "name": "inventory-app",
  "enabled": true
}
*/

Console.WriteLine("Ready");
```

Recognition examples:

| Source | Behavior |
| --- | --- |
| `/*markdown\n...\n*/` | Markdown rich rendering and preview |
| `/*md\n...\n*/` | Same as `markdown` (alias) |
| `/*yaml\n...\n*/` or `/*yml\n...\n*/` | YAML syntax highlighting and preview |
| `/*sql\n...\n*/` | SQL syntax highlighting and preview |
| `/*json\n...\n*/` | JSON syntax highlighting and preview |
| `/** ... */` | Ordinary C# documentation comment; **no toolkit rendering by default** |
| `/* ordinary comment */` | Ordinary C# comment; unchanged |
| `"/*markdown\n...*/"` | C# string content; never interpreted as a tagged comment |
| `/*unknownLanguage\n...*/` | Ordinary comment; unchanged (optionally show a diagnostic only if configured) |

For 0.1.0, the opening tag should be alone on the opening line; optional horizontal whitespace may follow the language ID. This eliminates ambiguity with an ordinary sentence after `/*`. Future revisions may opt in to inline bodies. Do not strip language-specific characters from body text.

**C# constraint:** The first `*/` closes the outer C# comment, even if the embedded language would consider those characters part of its own string. Neither lexer nor preview may reinterpret invalid C# comment boundaries.

### 2.2 Two rendering modes, one shared parser

- **Document mode (`markdown`, `md`):** Editor decorations for headings/emphasis/lists; `MarkdownString` hover; synchronized rich HTML preview for headings, tables, links, lists, code fences, etc. Native editor source text remains visible/editable; full HTML does not render in place.
- **Code mode (`yaml`, `json`, `sql`, etc.):** Syntax highlighting **inside the comment body** using a VS Code TextMate injection grammar where practical. A preview shows the extracted body as theme-aware syntax-highlighted code, with a copy-content and jump-to-source affordance. Preview is not a Markdown-rendered document.
- **Language-specific optional mode:** YAML/JSON syntax validation or tree view may be considered later, separately from rendering. No schema validation, auto-formatting, or execution occurs implicitly.

The scanner and language registry are shared by both modes so that supported tags, ranges, aliases, line maps, and security policy stay consistent.

### 2.3 Native editor implementation strategy

The most promising inline syntax path is **TextMate injection grammars** contributed to VS Code's existing C# grammar (root scope `source.cs`). Use the Scope Inspector in a running VS Code version to verify the exact C# block-comment scope and the interaction with C# semantic highlighting. A grammar may assign distinct embedded scopes and include the appropriate TextMate syntax rules. Existing language grammar availability varies; **do not assume** arbitrary installed language grammars can be loaded dynamically merely from a tag string.

An injection's ability to claim the entire tagged comment and interact with the parent `*/` rule must be verified in a prototype before treating it as a deliverable. If injection behavior conflicts with C# grammar or semantic tokens, use `TextEditorDecorationType` to apply a **bounded, token-level color overlay** and retain a full-highlight preview. Avoid per-character decorations and whole-document rescans on each keystroke. Injection is preferable for theme integration but is not guaranteed.

TextMate embedded language scopes can influence basic editor behaviors (bracket matching, comments/snippets) if `embeddedLanguages` is configured. This extension's **MVP focuses on highlighting, not a complete embedded language mode**; enable such behaviors only after tests confirm they do not interfere with C# editing.

A separate optional Custom Text Editor remains a post-MVP investigation, not the default `.cs` editor.

### 2.4 Preview UX

A single **Preview Tagged Comments** action opens a beside-editor Webview. It lists tagged blocks by source order, badge/label for language, and source line number. Each block uses its registered renderer:

- Markdown: sanitized rich document rendering.
- Code-like languages: preformatted highlighted code via a bundled highlighter (e.g., Shiki, pinned languages/themes) with graceful plaintext fallback for unknown grammar.
- Highlighted source and rendered preview stay in sync on edits using debounce and source maps.
- Click a block header / source location to navigate to its original range; never rewrite comment contents from preview.

Webview follows strict CSP, resource restrictions, no untrusted scripts/HTML, and no executing content contained in tagged comments. Avoid external CDN dependencies; ship highlighter/grammars with the extension or fetch only trusted extension resources.

## 3. File-based app recognition

Do not equate `*.cs` with a file-based app.

1. **Strong signal:** `.cs` contains a file-based directive at the beginning of the file (`#:sdk`, `#:package`, `#:project`, `#:property`, or `#:include`) or a supported .NET shebang.
2. **Candidate signal:** `.cs` is outside a conventional project context and appears to contain top-level executable code. Treat as a candidate, not proof.
3. **Manual override:** command **Enable File Apps Toolkit for This File**, persisted by URI/workspace setting if desired; provide a complementary disable command.
4. Default behavior: expose actions to strong matches; allow candidate files through manual opt-in. A setting may offer a broader "all standalone .cs files" mode.
5. Before any CLI operation, validate the actual target URI, file existence, `file` scheme, workspace trust, and SDK support. Do not rely on an active-editor-only context key for authorization or target selection.
6. Handle multiple editors, multi-root workspaces and the URI passed by editor title menu actions. Remote SSH/WSL/Dev Containers run within the workspace extension host and use its filesystem/SDK. Browser-only VS Code contexts without process execution show a clear unsupported message.

## 4. Action design

### 4.1 Editor title (visible toolbar)

Primary icons in `editor/title` (order may be adjusted to avoid conflict with C# extensions):

| Label | Command ID | Implementation | Notes |
| --- | --- | --- | --- |
| Run File | `dotnetFileApps.runFile` | `dotnet run --file <absolute-file.cs>` | Primary action; supports optional app args after `--` |
| Restore | `dotnetFileApps.restore` | `dotnet restore <absolute-file.cs>` | Explicit restore despite implicit restore on run/build |
| Convert to Project | `dotnetFileApps.convertToProject` | `dotnet project convert <absolute-file.cs>` | Confirm destination/collision, explain original file is retained |
| Preview Tagged Comments | `dotnetFileApps.previewComments` | Language-aware preview webview | Toggle/open beside the source |
| More Actions | `dotnetFileApps.showActions` | `showQuickPick` | Access less frequent commands |

VS Code may overflow some icons depending on editor width. All commands also appear in Command Palette and contextual menus. Use `when` expressions such as `resourceExtname == .cs && resourceScheme == file` combined with an extension-maintained active-document context; command handlers **recheck** the target URI.

### 4.2 More Actions / Command Palette

| Feature | CLI or behavior | Phase | UX rationale |
| --- | --- | --- | --- |
| Run with Arguments | `dotnet run --file <file.cs> -- <args...>` | MVP | Prompt user for structured application arguments; parse safely |
| Build | `dotnet build <file.cs>` | MVP | Common during development |
| Clean File | `dotnet clean <file.cs>` | MVP | Useful for build problems |
| Publish Executable | `dotnet publish <file.cs>` | MVP | Confirm output directory and warn that Native AOT is enabled by default |
| Pack as Tool | `dotnet pack <file.cs>` | Phase 2 | Relevant but less frequently used |
| Clean Old File-App Cache | `dotnet clean file-based-apps` | Phase 2 | Global/cache-side effect; require clear confirmation, optional `--days` |
| Select Launch Profile | `dotnet run --file <file.cs> --launch-profile <name>` | Phase 2 | Inspect `<basename>.run.json` or the conventional launch settings file |
| Create Launch Profile | Generate `<basename>.run.json` | Phase 2 | Workspace edit with preview; preserve existing file |
| Add NuGet Package | Insert/update `#:package Package@Version` | Phase 2 | **Do not assume** `dotnet package add --file` exists; official CLI documentation targets `.csproj` |
| Add Project Reference | .NET 11+: `dotnet reference add --file <file.cs> <project.csproj>` | Phase 2 | SDK-version gated; on .NET 10 optionally edit `#:project` with user confirmation |
| Edit Build Directive | Safe edits to `#:sdk`, `#:property`, `#:project`, `#:include` | Phase 2 | Validate placement, duplicates, version support |
| Format | `dotnet format <file.cs>` if supported by installed SDK | Phase 2 | Detect support; do not preempt standard C# formatter |
| User Secrets | Direct user to `dotnet user-secrets ... --file <file.cs>` | Later | Never echo secret values into logs, terminal history, or task definitions |
| Open Documentation | Open official Microsoft Learn page | MVP | Low-cost discoverability |

**Excluded from toolbar:** piping code via stdin (`dotnet run -`), Unix shebang chmod, SDK cache diagnostics, or exposing secret values. These are not appropriate one-click editor actions.

### 4.3 .NET SDK capability gating

- Baseline: .NET SDK 10.0.100 or later for `dotnet run --file`.
- `#:include`: .NET SDK 10.0.300+ or .NET 11+, with more specific restrictions for DLL inclusion.
- `dotnet reference ... --file`: .NET 11+.
- Check `dotnet --version` with `cwd` set to the source file directory (honor `global.json`) and, for optional operations, probe CLI help/capabilities as needed.
- Treat CLI output and error codes as authoritative; do not imply successful conversion/publishing unless the command succeeds.

## 5. Command execution architecture

Use a shared `DotnetCommandRunner`:

1. Obtain the clicked editor's `Uri` (not only `window.activeTextEditor`).
2. Ensure any unsaved changes are saved first, with an explicit save prompt on cancel/failure. Reject untitled files until saved to `.cs`.
3. Resolve SDK executable (default `dotnet` on the workspace host) and set `cwd=dirname(fileUri.fsPath)` so `nuget.config`, `global.json`, `Directory.Build.props` and local resource paths behave as expected.
4. Construct the process with an **argument array** rather than concatenating a shell string. Example: `['run', '--file', absolutePath, '--', ...appArgs]`.
5. Prefer `vscode.Task` + `vscode.ProcessExecution` for commands needing an integrated terminal and cancellation; use a dedicated task label such as `File Apps: Run app.cs`. For quick SDK probes use `child_process.execFile`/`spawn` without shell, with timeout and capped output.
6. Surface task progress, stdout/stderr, exit status, and errors; use compatible problem matchers for build diagnostics where available.
7. Avoid duplicate concurrent operations on the **same source file** to prevent .NET file-based build-cache contention; allow independent files to run.
8. For conversion, calculate the documented output folder, check for collisions, ask for confirmation, then open generated project after verifying the output exists. Do not silently overwrite user files.
9. Respect `workspace.isTrusted` and fail closed for untrusted workspaces before executing code or generating files.
10. On Windows, Linux, and macOS avoid manual quoting with the user's shell. Absolute paths and application args must be passed as discrete process arguments.

## 6. Language-tagged comment detection, highlighting, and preview

### 6.1 Language registry / alias policy

Implement `EmbeddedLanguageRegistry` as the single source of truth. It should use a typed, declarative descriptor rather than scattering language comparisons through code:

```ts
type RenderMode = 'document' | 'code';

interface EmbeddedLanguageDescriptor {
  id: string;                       // canonical ID: "markdown", "yaml", ...
  aliases: readonly string[];        // "md", "yml", ...
  mode: RenderMode;
  grammarScope?: string;             // for available TextMate injection grammars
  previewLanguage?: string;         // syntax highlighter's normalized ID
  hover?: boolean;                  // Markdown enabled by default
  validate?: boolean;               // opt-in, never execute payload
}
```

Language coverage plan:

| Phase | Canonical language (accepted aliases) | Editor behavior | Preview behavior |
| --- | --- | --- | --- |
| MVP | Markdown (`markdown`, `md`) | Heading/emphasis/list decorations; experimental grammar injection | Rich Markdown HTML |
| MVP | YAML (`yaml`, `yml`) | YAML syntax highlighting | Highlighted YAML |
| MVP | JSON (`json`) | JSON syntax highlighting | Highlighted JSON |
| MVP | SQL (`sql`) | SQL syntax highlighting | Highlighted SQL |
| MVP | XML (`xml`) | XML syntax highlighting | Highlighted XML |
| MVP | Bash (`bash`, `sh`, `shell`) | Shell syntax highlighting | Highlighted Shell |
| MVP | PowerShell (`powershell`, `ps1`) | PowerShell syntax highlighting | Highlighted PowerShell |
| MVP | C# (`csharp`, `cs`) | C# syntax highlighting | Highlighted C# |
| Phase 2 | JavaScript (`javascript`, `js`), TypeScript (`typescript`, `ts`) | Syntax highlighting | Highlighted code |
| Phase 2 | HTML (`html`), CSS (`css`) | Syntax highlighting | Highlighted code (do **not** execute/render HTML) |
| Phase 2 | Python (`python`, `py`), C++ (`cpp`, `c++`) | Syntax highlighting | Highlighted code |
| Phase 2 | TOML (`toml`), INI (`ini`), Dockerfile (`dockerfile`) | Syntax highlighting | Highlighted code |
| Phase 2 | CSV (`csv`), plaintext (`text`, `plaintext`) | Plain or column-aware presentation | Escaped text |

**MVP count is a target, not a guarantee:** all listed MVP languages require verified inline tokenization. If a language's TextMate injection is incompatible, ship the fallback decoration implementation and document the limitation. Avoid bundling dozens of unused grammars; track extension size and startup memory. New languages should be added mainly through registry + a grammar adapter + fixtures + tests.

An unknown tag is left as an ordinary C# comment by default. Do not silently interpret unknown tags as Markdown or load arbitrary grammars/scripts from untrusted workspace content.

### 6.2 C#-aware `TaggedCommentScanner`

1. Identify *actual* C# block comment tokens, not `/*...*/` sequences occurring in normal/verbatim/raw/interpolated strings, chars, or line comments. Use robust tokenization or a tested lexical parser; never use a single unchecked global regex against the entire document.
2. Confirm opening marker `/*<language>` with boundary after tag and, for MVP, marker-only first line. Normalize aliases and ignore unknown IDs.
3. Preserve `{ id, language, mode, startOffset, endOffset, bodyStartOffset, bodyEndOffset, startLine, endLine, rawBody, normalizedBody, lineMap }`. `normalizedBody` is for presentation, while `rawBody` must preserve exact content for copy.
4. Keep all source offsets based on the original file text. Optional indentation dedent is **display-only** and must retain correct source mapping, especially for YAML whitespace-sensitive semantics, Markdown code fences, and Python.
5. Handle CRLF/LF, Unicode, empty bodies, very long bodies, incomplete comments, multiple languages and nested-looking delimiters. The first `*/` always terminates the comment.
6. Cache per `document.uri` + `document.version`; update visible regions with throttling/debounce as needed. Dispose decorations/providers when editors close.

Suggested test cases:

```csharp
/*markdown
# Quick start

**Important**: use the `--file` flag.
*/

/*yaml
server:
  port: 8080
  enabled: true
*/

/*sql
SELECT name, created_at
FROM users
WHERE active = 1;
*/

// Ordinary text and XML docs stay untouched:
/** C# documentation comment */
/* This is just a normal comment. */

var sample = "/*json\n{ \"not\": \"a real comment\" }\n*/";
```

### 6.3 Syntax-highlighting engine / editor decorations

- **Primary:** contribute static TextMate injection grammar(s) to C# `source.cs`, with separate rules for language tags. Reuse existing grammar scopes only after checking actual availability/licensing and VS Code version. Keep keyword/token scope mapping theme-friendly, rather than hard-coded foreground colors.
- **Fallback:** use a bundled tokenizer/highlighter on extracted source (e.g., grammar-backed), translate tokens into coalesced `vscode.Range`s and a small reusable set of `TextEditorDecorationType`s. Apply only to tagged body ranges; clip large files / cap tokens; do not overwrite C# code outside the comment.
- **Markdown decorations:** emphasize headings, links, emphasis, list prefixes; do not conceal source punctuation or fake rich multiline layout inside ordinary text editor.
- **Semantic highlighting:** verify C# language server tokens do not paint over injected comment scopes; document degraded behavior if semantic and injected scopes conflict. Use preview as guaranteed full-syntax presentation.
- **No implicit behavior:** no execution, file writes, package installation, schema downloads, IntelliSense promises, or automatic conversion of comment contents.

### 6.4 Hover, rendering, and security

- Markdown Hover via `registerHoverProvider` + `MarkdownString` (`isTrusted=false`, `supportHtml=false`), only for recognized `markdown` comment bodies.
- For code tags, Hover is optional; if enabled, show a bounded code-fenced excerpt tagged with language rather than pretending YAML/SQL has rich document rendering.
- Webview Preview uses sanitized Markdown (disable raw HTML by default) and HTML-escaped highlighted code. Implement a strict CSP, fixed `localResourceRoots`, no `command:` link execution, no remote scripts, and no parsing/evaluating arbitrary embedded code.
- Expose jump-to-source navigation via explicit VS Code messages; validate message contents and avoid arbitrary command dispatch or path traversal.
- Use webview-safe, bundled dependencies; language grammars may be loaded lazily for memory and package-size control.
- Preview render failure should show **escaped plaintext** and an explanation, not crash the extension.

### 6.5 UX and configuration

| Setting | Suggested default | Meaning |
| --- | --- | --- |
| `dotnetFileAppsToolkit.comments.enabled` | `true` | Enable tagged-comment recognition/visuals |
| `dotnetFileAppsToolkit.comments.highlight.enabled` | `true` | Syntax highlighting inside tagged comments |
| `dotnetFileAppsToolkit.comments.highlight.strategy` | `auto` | `auto` / `injection` / `decorations` / `off` (for tested environments) |
| `dotnetFileAppsToolkit.comments.markdown.hover` | `true` | Rich Markdown hover for `/*markdown` |
| `dotnetFileAppsToolkit.comments.previewOnOpen` | `false` | No auto-open of preview |
| `dotnetFileAppsToolkit.comments.unknownTagDiagnostic` | `false` | Optional unknown tag warning; off by default |

Do not use an extension setting to suggest dynamic loading of arbitrary TextMate grammar modules in MVP; the registry should remain an allowlist. Existing `dotnetFileAppsToolkit.markdown.*` settings from the first draft are **removed before 0.1.0 ships**, not retained as deprecated API.

## 7. Suggested repository layout

```text
dotnet-file-apps-toolkit/
├── .github/
│   └── workflows/ci.yml
├── syntaxes/
│   └── tagged-comments.injection.tmLanguage.json   # after TextMate POC
├── src/
│   ├── extension.ts
│   ├── commands/
│   │   ├── registerCommands.ts
│   │   └── actions.ts
│   ├── dotnet/
│   │   ├── sdkService.ts
│   │   ├── commandRunner.ts
│   │   └── fileAppDetector.ts
│   ├── comments/
│   │   ├── taggedCommentScanner.ts
│   │   ├── embeddedLanguageRegistry.ts
│   │   ├── normalization.ts
│   │   ├── syntaxHighlightController.ts
│   │   ├── syntaxGrammarAdapter.ts
│   │   ├── markdownDecorations.ts
│   │   ├── hoverProvider.ts
│   │   └── previewPanel.ts
│   ├── ui/
│   │   └── actionPicker.ts
│   └── core/
│       ├── settings.ts
│       ├── logging.ts
│       └── errors.ts
├── media/
│   └── preview.css
├── test/
│   ├── unit/                 # tag grammar, registry, parser, normalization
│   └── integration/          # editor highlighting, webview, CLI commands
├── fixtures/
│   ├── hello.cs
│   ├── tagged-markdown.cs
│   ├── tagged-yaml-json-sql.cs
│   ├── multi-language-comments.cs
│   ├── ordinary-comments.cs
│   └── strings-with-comment-markers.cs
├── package.json
├── tsconfig.json
├── esbuild.js
├── README.md
├── CHANGELOG.md
└── LICENSE
```

## 8. Contribution and configuration contract

- `package.json` contributes command IDs under `dotnetFileApps.*`, editor menus under `editor/title`, `editor/context`, `commandPalette`, and C# grammar injection via `contributes.grammars` + `injectTo: ["source.cs"]` **once validated**.
- `activationEvents`: activate for the C# editor (`onLanguage:csharp`) with lazy processing. Note: TextMate grammar contributions are declarative and loaded independently from extension-host activation.
- `extensionKind`: `workspace` for CLI execution in remote environments; don't promise CLI support on browser-only hosts.
- Suggested settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `dotnetFileAppsToolkit.enabled` | `true` | Toolkit commands and presentation controls |
| `dotnetFileAppsToolkit.fileDetection` | `strict` | `strict` / `standalone` / `manual` |
| `dotnetFileAppsToolkit.dotnetPath` | `dotnet` | SDK executable on extension host |
| `dotnetFileAppsToolkit.autoSaveBeforeRun` | `prompt` | `prompt` / `always` / `never` (never must block when dirty) |
| `dotnetFileAppsToolkit.run.args` | `[]` | Default application args, not shell text |
| `dotnetFileAppsToolkit.comments.enabled` | `true` | Recognize explicit `/*<language>` blocks |
| `dotnetFileAppsToolkit.comments.highlight.enabled` | `true` | Visual token highlighting in C# comments |
| `dotnetFileAppsToolkit.comments.highlight.strategy` | `auto` | Preferred highlighting implementation |
| `dotnetFileAppsToolkit.comments.markdown.hover` | `true` | Markdown rich hover |
| `dotnetFileAppsToolkit.comments.previewOnOpen` | `false` | Auto-open tagged comment preview |

**Important implementation caveat:** declarative TextMate injection contributions cannot always be toggled at runtime through a regular extension setting. For a true `comments.enabled=false` guarantee, the extension needs a tested decoration-only mode, a separate opt-in language integration, or clearly documented limitations. The code agent must verify this behavior and not make inaccurate UI claims. The preview/hover/decorations can be disabled independently; grammar contribution activation is governed by VS Code itself.

Avoid adding a required dependency on C# Dev Kit; integrate when present but keep syntax/preview functionality usable without it.

## 9. Milestones (in dependency order)

### P0 — Extension skeleton and capability probe

- [ ] Scaffold TypeScript VS Code extension and bundler.
- [ ] Register command IDs, editor title contribution points, and context menu.
- [ ] Detect SDK from file directory; validate version and `global.json` behavior.
- [ ] Implement strict file-app recognition and optional manual opt-in.
- [ ] Add diagnostics/logging output channel and actionable error notifications.

**Acceptance:** extension activates on qualifying `.cs`; doesn't trigger inappropriate commands on a normal project file; displays a useful error without a suitable SDK.

### P1 — Core CLI interactions (first working version)

- [ ] Implement `runFile`, `restore`, `convertToProject`, `build`, `clean`, and `publish`.
- [ ] Implement `showActions` QuickPick and Run with Arguments.
- [ ] Use tasks/process argument arrays, explicit `cwd`, save-before-run, and cancellation.
- [ ] Check output/exit status and guard against destructive/colliding conversion.

**Acceptance:** with .NET SDK 10+, app runs in integrated terminal; restore/build/clean/publish work on fixtures; conversion produces a project with the original file preserved.

### P2a — Explicit tagged comments and rendering foundation

- [ ] Replace old `/**` Markdown-only behavior with an explicit `/*<language>` tag contract.
- [ ] Build `TaggedCommentScanner` with source maps, C#-aware string/comment recognition and unit tests.
- [ ] Build `EmbeddedLanguageRegistry` and alias resolution; unknown/ordinary comments remain unchanged.
- [ ] Implement Markdown hover, editor decoration fallback and rich Markdown preview.
- [ ] Implement syntax-highlighted code preview with YAML, JSON, SQL, XML, Bash, PowerShell and C# grammar support (lazy loaded if feasible).
- [ ] Implement preview source navigation, safe update, bounded caching and strict Webview CSP.

**Acceptance:** Markdown is richly rendered in preview, YAML/JSON/SQL/etc. appear as highlighted code in preview; only explicit tagged comments are recognized; ordinary `/** */` isn't automatically rendered.

### P2b — Inline syntax highlighting proof and implementation

- [ ] Build a minimal `source.cs` TextMate injection prototype for `/*yaml` and `/*json`.
- [ ] Confirm scopes using VS Code Scope Inspector; test opening tag, multiline body, C# comment terminator and sibling comments.
- [ ] Verify themed highlighting and interoperability with C# semantic highlighting / C# Dev Kit.
- [ ] Generalize injection rules to the MVP language list only where verified.
- [ ] For unsupported/conflicting cases, implement performant token-level `TextEditorDecorationType` fallback.
- [ ] Confirm enabling/disabling setting behavior; document grammar injection limitations.

**Acceptance:** `/*yaml` highlights keys/strings/values in the **native `.cs` editor**, not only in webview, without changing other C# code or comments; a documented, working fallback exists.

### P3 — Integration, accessibility, and release

- [ ] Unit tests for parser, alias registry, normalizer, detector, argument builder and SDK gating.
- [ ] VS Code integration tests for toolbar, command targets, injection/decoration highlighting, hover and preview.
- [ ] Validate Windows, Linux, macOS, WSL/SSH/Dev Containers where available.
- [ ] Confirm keyboard accessibility, theme contrast, localization-ready strings, disposal, and graceful fallback.
- [ ] CI lint/typecheck/unit tests, supported integration tests, bundle and VSIX.
- [ ] README with examples of `/*markdown`, `/*yaml`, `/*json`, supported aliases, known limitations, screenshots and compatibility table.

**Acceptance:** clean CI, no source mutation on read-only features, no injection on odd filenames, works on multiple editor tabs/paths with spaces, `.vsix` installs and documented demos reproduce.

### P4 — Post-MVP enhancements

- [x] Add more mainstream languages: JS/TS, HTML, CSS, Python, C++, TOML, INI, Dockerfile and CSV.
- [x] Optional YAML/JSON validation and structure previews (opt-in only).
- [x] Optional code snippet actions (copy-to-clipboard, extract-to-file with confirmation); **never execute embedded comment content**.
- [x] Pack as Tool, cache cleanup with confirmation, launch profile picker.
- [x] Add/update `#:package`, and inspect/edit `#:sdk`, `#:property`, `#:project`, `#:include`.
- [x] .NET 11 SDK-gated project reference actions and optional format command.
- [x] Optional CodeLens near file entry point or tagged comments, with settings to avoid clutter.
- [x] Evaluate optional inline WYSIWYG editor as a separately maintained prototype.

**WYSIWYG evaluation:** Keep the shipped preview read-only. Its webview currently receives rendered HTML and accepts only validated `ready`, `reveal`, and `copy` messages; editing would add a bidirectional, version-sensitive source-editing protocol. Exact preservation of comment delimiters, indentation, line endings, and arbitrary embedded-language bodies makes this a separate editing product rather than a small preview enhancement. If pursued, prototype it separately, starting with Markdown-only blocks and version-checked edits that replace only the selected block body.

## 10. Test matrix and edge cases

| Area | Tests |
| --- | --- |
| Tag recognition | `/*markdown`, `/*md`, `/*yaml`, `/*yml`, `/*json`, unknown tags, casing, token boundaries, marker-only line |
| Ordinary comments | `/** */`, `/* normal */`, line comments, `/*markdownExtra...*/` remain unchanged |
| C# lexing | tag-like content in quoted/verbatim/raw/interpolated strings, chars and `//` comments; open/incomplete comments |
| Multiple languages | markdown + YAML + SQL in one source; correct rendering strategy and source location |
| Normalization | CRLF/LF, Unicode, whitespace-sensitive YAML/Python, Markdown code fences, exact copy of raw body |
| Editor highlighting | injection grammar scopes, fallback decorations, theme changes, C# semantic token interactions, large files |
| Preview | Markdown rich rendering, code highlighted as code, unavailable grammars -> escaped plaintext; scroll & source navigation |
| CLI | no SDK, .NET 9, .NET 10, .NET 11, global.json pin, failed restore, nonzero exit, cancellation |
| File paths | spaces, quotes, Unicode, Windows paths, symlinks, multi-root and remote workspace |
| Editing | unsaved text, file rename/delete, active editor switching, two concurrent tabs |
| Security | untrusted workspace, `command:` Markdown links, raw HTML/JS in tagged Markdown and HTML tags, external resource URLs |
| UX | dark/light theme, accessibility, narrow toolbar, command availability, large-file/performance limits |

## 11. Definition of Done for 0.1.0

- [ ] Editor toolbar runs against intended `.cs` URI and remains contextual.
- [ ] Run, Restore, Convert, Build, Clean and Publish work with a supported SDK.
- [ ] Every CLI run reports its outcome; failures never appear successful.
- [ ] Only explicitly tagged `/*<known-language>` blocks participate; `/** */` and ordinary comments do not.
- [ ] Markdown tags have rich hover/preview; YAML, JSON, SQL, XML, Bash, PowerShell and C# tags have highlighted code previews.
- [ ] YAML/JSON inline native-editor syntax highlighting works via verified injection grammar **or** performant decoration fallback; all shipped MVP languages have clear compatibility behavior.
- [ ] Read-only rendering never edits the source; Convert preserves the original source.
- [ ] Workspace trust, preview injection safety, argument safety, SDK gating and unsupported environments are covered.
- [ ] Passing tests and a distributable `.vsix` exist.

## 12. Implementation guidance for GitHub Copilot / coding agents

Execute **P0 → P1 → P2a → P2b → P3** in small reviewable pull requests. Before each milestone, identify interfaces/files, write tests for scanner/alias resolution/normalization, and verify grammar behavior in a real VS Code Extension Development Host.

**Language-tag contract is mandatory:** **do not** implement automatic Markdown rendering for `/** */`. Only explicitly supported `/*markdown`, `/*yaml`, etc. should trigger specialized rendering. Design around a shared language registry so adding a language rarely changes scanning/preview infrastructure.

First investigate official **injection grammar** behavior against `source.cs`; confirm with Scope Inspector and tests. Do not assume editor decorations can perform full WYSIWYG layout, nor that simply marking a comment region as embedded language grants IntelliSense/LSP features. Prefer native APIs and theme-friendly scopes, but use a performant decoration fallback when injection is incompatible. Visual previews must not execute user content.

Never assume a .NET CLI command exists merely because a similarly named project-based CLI command exists. Follow the CLI safety, workspace trust, SDK gating and file preservation requirements in sections 3-5.

## References (official)

- .NET file-based apps: https://learn.microsoft.com/en-us/dotnet/core/sdk/file-based-apps
- `dotnet run` (`--file`): https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-run
- `dotnet reference add`: https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-reference-add
- `dotnet package add`: https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-package-add
- VS Code Syntax Highlighting / Injection Grammars: https://code.visualstudio.com/api/language-extensions/syntax-highlight-guide
- VS Code contribution points: https://code.visualstudio.com/api/references/contribution-points
- VS Code Extension API: https://code.visualstudio.com/api/references/vscode-api
- VS Code Webview API: https://code.visualstudio.com/api/extension-guides/webview
- VS Code Custom Editor API: https://code.visualstudio.com/api/extension-guides/custom-editors
- VS Code Task Provider: https://code.visualstudio.com/api/extension-guides/task-provider
- VS Code bundled C# grammar (source.cs): https://github.com/microsoft/vscode/blob/main/extensions/csharp/syntaxes/csharp.tmLanguage.json

