# rayomd-mcp

An [MCP](https://modelcontextprotocol.io) server that turns Markdown into PDF with
[RayoMD](https://github.com/Butterski/rayomd): natively, with no browser, TeX or Pandoc in the
agent's environment, the same PDF on every run, about a millisecond a document. Agents that write
reports, summaries, release notes or documentation call `markdown_to_pdf` and get a PDF, its
page count and what did not render.

```sh
npx rayomd-mcp --root ~/Documents/reports
```

It speaks MCP over stdio, built on the official TypeScript SDK v2
(`@modelcontextprotocol/server` 2.4.0, protocol revision 2026-07-28); the SDK's `serveStdio`
also answers 2025-era clients' `initialize` (tested with `2025-06-18`).

## Install

Node.js 20 or newer. Nothing else: the server finds or fetches the `rayomd` binary itself.

1. `RAYOMD_PATH`, when set: the rayomd executable to use.
2. Else `rayomd` on `PATH` (`rayomd.exe` on Windows).
3. Else the RayoMD release pinned in this package, downloaded on first use from
   [GitHub releases](https://github.com/Butterski/rayomd/releases) (the static Linux x64
   tarball, the Windows x64 zip), checked against the SHA-256 recorded in
   [`src/client/releases.ts`](src/client/releases.ts) and kept in `~/.cache/rayomd/bin/<version>/`
   (`$XDG_CACHE_HOME/rayomd/bin`, `%LOCALAPPDATA%\RayoMD\cache\bin` on Windows). A download whose
   hash differs is not used. After the first download the server works offline.

`npx rayomd-mcp --install-binary` does step 1 to 3 at once and prints the binary's path, for
machines that go offline later. macOS and Linux on ARM have no release binary: build rayomd from
source and put it on `PATH` or in `RAYOMD_PATH`.

The server needs a rayomd with `--serve --json` (protocol 1). An older rayomd on `PATH` is
reported as such in the tool's error; update it, remove it from `PATH` or point `RAYOMD_PATH` at
a newer one.

## Configure a client

Always pass `--root` with the folders the agent may use: a desktop client starts servers in a
working folder of its own choosing.

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "rayomd": {
      "command": "npx",
      "args": ["-y", "rayomd-mcp", "--root", "/Users/me/Documents/reports"]
    }
  }
}
```

On Windows use `"command": "cmd", "args": ["/c", "npx", "-y", "rayomd-mcp", "--root", "C:\\Users\\me\\Documents\\reports"]`.

**Claude Code**:

```sh
claude mcp add rayomd -- npx -y rayomd-mcp --root "$PWD"
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "rayomd": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "rayomd-mcp", "--root", "${workspaceFolder}"]
    }
  }
}
```

**MCP Inspector**: `npx @modelcontextprotocol/inspector npx -y rayomd-mcp --root .`
(or `--cli ... --method tools/list` without a browser).

## Tools

Each tool answers with `structuredContent` (its `outputSchema`), a `resource_link` to the file
written (a `file://` URI) and one line of text. Failures are tool results with `isError: true`
and a message the model can act on.

### `markdown_to_pdf`

Markdown text (`markdown`) or a file (`path`) to the PDF `output`. Annotations: not read-only,
not destructive, idempotent, not open-world.

| Argument | Flag | |
|---|---|---|
| `markdown` / `path` | | exactly one of them |
| `output` | | the PDF, ending in `.pdf`; an existing file is replaced |
| `source_path` | | with `markdown`: the `.md` file the text stands for; relative images resolve from its folder. Default: `output` with `.md` |
| `style` | `elegant` `modern` `tech` | |
| `margin` | `compact` `normal` `wide` `margin=0.75in` `margin=54pt` | |
| `page_size` | `--page-size=` | `a4` `a3` `a5` `letter` `legal`, `-landscape`, `210x297mm`, `210mmxauto` |
| `toc`, `toc_depth` | `--toc`, `--toc-depth=N` | |
| `number_headings` | `--number-headings=N` | 1 to 6 levels |
| `page_numbers` | `--page-numbers` | |
| `footnotes` | `--footnotes=end\|page` | |
| `dialect` | `--dialect=github\|obsidian` | |
| `pdfa`, `pdfua` | `--pdfa`, `--pdfua` | |
| `black_text` | `--black-text` | |
| `highlight_code: false` | `--no-highlight` | |
| `diagrams: false` | `--no-diagrams` | |
| `page_break_before` | `--page-break-before=hN` | `h1` to `h6` |
| `allow_url_images` | `--allow-url-images` | only with the server's `--allow-url-images` |
| `allow_unsafe_local_images` | `--allow-unsafe-local-images` | only with the server's `--allow-unsafe-local-images` |
| `theme` | `--theme=FILE` | only with `--allow-theme`; the file inside the roots |
| `embed_source` | `--embed-source` | only with `--allow-embed-source` |

The answer is rayomd's `--report` record: `input`, `output`, `status`, `code`, `pages`,
`bytes`, `ms`, `missing_characters` (characters no font had), `failed_images` (images printed
as their alt text). The PDF is byte-identical to `rayomd --export <file> <output> <flags>` (for
`markdown`, to `--export` of a file at `source_path` holding that text). The description
carries a short form of the syntax reference.

### `book_to_pdf`

`inputs`: one `SUMMARY.md` (mdBook, GitBook), one folder (its `SUMMARY.md`, else its Markdown
files by name, `README.md` first) or Markdown files in order; `output`; the same options but
`embed_source`. Runs `rayomd --book <inputs> <output> <flags>` once, without a shell; the files
a `SUMMARY.md` lists or a folder holds must lie in that folder (rayomd checks). Answers
`inputs`, `output`, `pages`, `bytes`, `ms`, `missing_characters`.

### `recover_markdown`

`pdf`: a PDF exported with the source embedded (`embed_source`, so the server needs
`--allow-embed-source` to make one, or one made by `rayomd --embed-source`). Without `output`
the Markdown comes back as the result's text and in `structuredContent.markdown`; with `output`
(a new `.md` file inside the roots) it is written there and never over an existing file. The
PDF is not changed. It is not marked read-only because it can write that new file.

### `open_in_gui`

`path`: a `.md` file inside the roots, opened in [RayoMD GUI](https://github.com/Butterski/rayomd-gui)
(`RAYOMD_GUI_PATH`, else `rayomd-gui` on `PATH`), started detached, without a shell. The GUI
checks the file about once a second and reloads it when it changed on disk and its buffer has no
unsaved edits, so the user sees each version the agent writes. Errors when the GUI is not
installed, when there is no Wayland display on Linux, or when it exits at once.

### Resource `rayomd://syntax`

What RayoMD renders (GitHub Markdown, alerts, footnotes, task lists, the TeX subset, Mermaid
flowcharts, sequence diagrams and pie charts, code in 29 languages) and what degrades (HTML and
CSS layout, LaTeX packages, other diagram types): the RayoMD skill's
`references/syntax.md`, vendored in [`resources/syntax.md`](resources/syntax.md).

## Security model

- **Roots.** Files are read and written only inside the `--root` folders (repeatable; default
  the working folder). Relative paths resolve from the first root. Every path is resolved to
  its real location (`..`, symbolic links, junctions) before the check: an input must be a file
  whose real path lies in a root; an output's real folder must lie in a root, its name must end
  in `.pdf` (`.md` for `recover_markdown`), and an existing output that is a link, a folder or a
  file with other hard links is refused. MCP roots (deprecated in 2026-07-28, SEP-2577) are not
  used.
- **Images.** rayomd loads local images only from the Markdown file's folder (`source_path`'s
  for text), so they stay inside the roots too, and no URL images.
- **Off unless the server's command line turns them on:** URL images (`--allow-url-images`),
  local images from anywhere (`--allow-unsafe-local-images`), theme files (`--allow-theme`, the
  theme file itself checked against the roots) and embedded sources (`--allow-embed-source`).
  Only then does the tool option exist. Tool calls never pass a raw flag to rayomd: every flag
  comes from a typed, validated option.
- **Processes.** rayomd and the GUI are started with argument arrays, never through a shell.
  One warm `rayomd --serve --json` child serves the conversions, one request at a time; a child
  that exits, breaks the protocol or does not answer within the timeout (60 s, `--timeout`) is
  stopped, that call fails, and the next call starts a new child. It is ended with the server.
- **Downloads.** Only the pinned release asset, only when its SHA-256 matches.

## Command line and environment

```
rayomd-mcp [--root DIR]... [--allow-url-images] [--allow-unsafe-local-images]
           [--allow-theme] [--allow-embed-source] [--timeout SECONDS]
rayomd-mcp --install-binary | --version | --help
```

| Variable | |
|---|---|
| `RAYOMD_PATH` | the rayomd executable |
| `RAYOMD_GUI_PATH` | the RayoMD GUI executable for `open_in_gui` |
| `XDG_CACHE_HOME`, `LOCALAPPDATA` | where the downloaded binary is kept |
| `RAYOMD_FONT`, `RAYOMD_FALLBACK_FONT` | read by rayomd itself: fonts for missing characters and PDF/A |

## The client library

`rayomd-mcp/client` is the binary resolver and `--serve --json` client on their own, for other
programs (the RayoMD VS Code extension):

```js
import { exportArgs, RayomdServe, resolveRayomd } from 'rayomd-mcp/client';

const serve = new RayomdServe({ command: async () => ({ command: (await resolveRayomd()).path }) });
const record = await serve.request({ input: 'notes.md', output: 'notes.pdf', args: exportArgs({ toc: true }) });
console.log(record.status, record.pages);
await serve.close();
```

It also exports `runRayomd` (one command, no shell), `downloadRelease`, `findOnPath`,
`RELEASE_SHA256` and the archive readers.

## Development

```sh
npm ci
npm test                                        # build, unit tests against test/fake-rayomd.mjs
RAYOMD_TEST_BINARY=/path/to/rayomd npm test     # and the real-binary suite (byte-identical PDFs)
RAYOMD_PATH=/path/to/rayomd npm run smoke       # raw JSON-RPC over stdio against dist/cli.js
npm run sync-syntax -- ../rayomd/skills/rayomd/references/syntax.md
npm run pin-release -- 5.3.0                    # pin a release's asset hashes and download it by default
```

A release: bump `version` in `package.json` and both versions in `server.json`, tag `vX.Y.Z`;
[`release.yml`](.github/workflows/release.yml) publishes to npm with provenance and to the MCP
Registry.

## License

Apache-2.0, as RayoMD. See [LICENSE](LICENSE).
