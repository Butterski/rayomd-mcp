<a id="readme-top"></a>

<div align="center">

<img src="https://raw.githubusercontent.com/Butterski/rayomd/master/docs/assets/branding/rayomd.png" alt="RayoMD mascot" width="150">

# rayomd-mcp

**Markdown to PDF for AI agents, over MCP, in about half a millisecond a call.**<br>
No browser. No LaTeX. No Pandoc. No Chrome to download.

<a href="https://github.com/Butterski/rayomd-mcp/releases"><img alt="Version: 0.1.0" src="https://img.shields.io/badge/version-0.1.0-informational?style=for-the-badge"></a>
<a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg?style=for-the-badge"></a>

<a href="https://github.com/Butterski/rayomd-mcp/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Butterski/rayomd-mcp/actions/workflows/ci.yml/badge.svg"></a>
<img alt="MCP: 2026-07-28 and 2025-06-18" src="https://img.shields.io/badge/MCP-2026--07--28%20%7C%202025--06--18-6f42c1">
<img alt="Node.js 20 or newer" src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white">
<img alt="Platforms: Windows and Linux" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-2ea44f">

[Quick start](#quick-start) ·
[Tools](#tools) ·
[Security](#security-model) ·
[Performance](#performance) ·
[RayoMD](https://github.com/Butterski/rayomd)

</div>

> [!NOTE]
> **Before the first release:** rayomd-mcp is not on npm yet, and it needs a RayoMD with
> `rayomd --serve --json` (protocol 1), which comes after 5.2.5. Until both are released, build
> RayoMD from `master` and run the server from this repository
> ([Build from source](#quick-start)).

rayomd-mcp is an [MCP](https://modelcontextprotocol.io) server around
[RayoMD](https://github.com/Butterski/rayomd), the native Markdown-to-PDF converter: agents that
write reports, summaries, release notes or documentation call `markdown_to_pdf` and get the PDF,
its page count and what did not render. One warm `rayomd` process converts each document in a
fraction of a millisecond; the server itself is one 460 KB JavaScript file on the official
TypeScript SDK v2.

## Highlights

<table>
<tr>
<td width="33%" valign="top">

### Fast
A small note in **0.5 ms** a call, end to end over stdio; ready **117 ms** after start, the
first call as fast as the rest.

</td>
<td width="33%" valign="top">

### Light
No headless browser, no TeX Live: one Node.js file and a 1.2 MB download of the static
`rayomd`, fetched once and checked against its SHA-256.

</td>
<td width="33%" valign="top">

### Contained
Reads and writes only inside `--root` folders, resolved through links; URL images, themes and
embedded sources off unless the server allows them.

</td>
</tr>
<tr>
<td valign="top">

### Same PDF every run
Byte-identical to `rayomd --export` with the same flags, tested on six option sets, PDF/A and
PDF/UA among them.

</td>
<td valign="top">

### Everything RayoMD draws
TeX math, Mermaid diagrams, code coloured in 29 languages, tables of contents, PDF/A-3b and
tagged PDF/UA-1.

</td>
<td valign="top">

### Live preview
`open_in_gui` opens the note in [RayoMD GUI](https://github.com/Butterski/rayomd-gui), which
follows each version the agent writes.

</td>
</tr>
</table>

## Quick start

Always pass `--root` with the folders the agent may use: a desktop client starts servers in a
working folder of its own choosing.

<details open>
<summary><b>Claude Code</b></summary>

```sh
claude mcp add rayomd -- npx -y rayomd-mcp --root "$PWD"
```

</details>

<details>
<summary><b>Claude Desktop</b>: <code>claude_desktop_config.json</code></summary>

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

</details>

<details>
<summary><b>VS Code</b>: <code>.vscode/mcp.json</code></summary>

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

</details>

<details>
<summary><b>MCP Inspector</b></summary>

```sh
npx @modelcontextprotocol/inspector npx -y rayomd-mcp --root .
npx @modelcontextprotocol/inspector --cli npx -y rayomd-mcp --root . --method tools/list
```

</details>

<details>
<summary><b>Build from source</b></summary>

Node.js 20 or newer, and a `rayomd` with `--serve --json` (build
[RayoMD](https://github.com/Butterski/rayomd) from `master` until its next release):

```sh
git clone https://github.com/Butterski/rayomd-mcp && cd rayomd-mcp
npm ci && npm run build
RAYOMD_PATH=/path/to/rayomd node dist/rayomd-mcp.mjs --root ~/Documents/reports
```

In a client's configuration: `"command": "node"`, `"args": ["/path/to/rayomd-mcp/dist/rayomd-mcp.mjs", "--root", "..."]`,
and `"env": {"RAYOMD_PATH": "/path/to/rayomd"}`.

</details>

The server finds `rayomd` itself:

1. `RAYOMD_PATH`, when set.
2. Else `rayomd` on `PATH` (`rayomd.exe` on Windows).
3. Else the RayoMD release pinned in this package, downloaded on the first call from
   [GitHub releases](https://github.com/Butterski/rayomd/releases) (the static Linux x64 tarball,
   the Windows x64 zip), checked against the SHA-256 recorded in
   [`src/client/releases.ts`](src/client/releases.ts) and kept in `~/.cache/rayomd/bin/<version>/`
   (`$XDG_CACHE_HOME/rayomd/bin`, `%LOCALAPPDATA%\RayoMD\cache\bin` on Windows). A download whose
   hash differs is not used; after the first one the server works offline.

`npx rayomd-mcp --install-binary` does this at once and prints the binary's path, for machines
that go offline later. macOS and Linux on ARM have no release binary: build rayomd from source
and put it on `PATH` or in `RAYOMD_PATH`. A rayomd without `--serve --json` is reported as such in
the tool's error.

## Tools

Each tool answers with `structuredContent` (its `outputSchema`), a `resource_link` to the file
written (a `file://` URI) and one line of text. Failures are tool results with `isError: true`
and a message the model can act on.

### `markdown_to_pdf`

Markdown text (`markdown`) or a file (`path`) to the PDF `output`. Not read-only, not
destructive, idempotent, not open-world.

```json
{ "markdown": "# Q3 report\n\nRevenue grew $\\frac{3}{2}$ times.", "output": "q3.pdf", "toc": true, "page_numbers": true }
```

| Argument | rayomd flag | |
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

The answer is rayomd's `--report` record: `input`, `output`, `status`, `code`, `pages`, `bytes`,
`ms`, `missing_characters` (characters no font had), `failed_images` (images printed as their
alt text). The PDF is byte-identical to `rayomd --export <file> <output> <flags>` (for
`markdown`, to `--export` of a file at `source_path` holding that text). The description carries
a short form of the syntax reference.

### `book_to_pdf`

`inputs`: one `SUMMARY.md` (mdBook, GitBook), one folder (its `SUMMARY.md`, else its Markdown
files by name, `README.md` first) or Markdown files in order; `output`; the same options but
`embed_source`. Runs `rayomd --book <inputs> <output> <flags>` once, without a shell; the files a
`SUMMARY.md` lists or a folder holds must lie in that folder (rayomd checks). Answers `inputs`,
`output`, `pages`, `bytes`, `ms`, `missing_characters`.

### `recover_markdown`

`pdf`: a PDF exported with the source embedded (`embed_source`, so the server needs
`--allow-embed-source` to make one, or one made by `rayomd --embed-source`). Without `output` the
Markdown comes back as the result's text and in `structuredContent.markdown`; with `output` (a new
`.md` file inside the roots) it is written there and never over an existing file. The PDF is not
changed. It is not marked read-only because it can write that new file.

### `open_in_gui`

`path`: a `.md` file inside the roots, opened in [RayoMD GUI](https://github.com/Butterski/rayomd-gui)
(`RAYOMD_GUI_PATH`, else `rayomd-gui` on `PATH`), started detached, without a shell. The GUI
checks the file about once a second and reloads it when it changed on disk and its buffer has no
unsaved edits, so the user sees each version the agent writes. Errors when the GUI is not
installed, when there is no Wayland display on Linux, or when it exits at once.

### Resource `rayomd://syntax`

What RayoMD renders (GitHub Markdown, alerts, footnotes, task lists, the TeX subset, Mermaid
flowcharts, sequence diagrams and pie charts, code in 29 languages) and what degrades (HTML and
CSS layout, LaTeX packages, other diagram types): the RayoMD skill's `references/syntax.md`,
vendored in [`resources/syntax.md`](resources/syntax.md). Agents that read it write Markdown that
renders instead of finding out from the PDF.

## Security model

- **Roots.** Files are read and written only inside the `--root` folders (repeatable; default the
  working folder). Relative paths resolve from the first root. Every path is resolved to its real
  location (`..`, symbolic links, junctions) before the check: an input must be a file whose real
  path lies in a root; an output's real folder must lie in a root, its name must end in `.pdf`
  (`.md` for `recover_markdown`), and an existing output that is a link, a folder or a file with
  other hard links is refused. MCP roots (deprecated in 2026-07-28, SEP-2577) are not used.
- **Images.** rayomd loads local images only from the Markdown file's folder (`source_path`'s for
  text), so they stay inside the roots too, and no URL images.
- **Off unless the server's command line turns them on:** URL images (`--allow-url-images`),
  local images from anywhere (`--allow-unsafe-local-images`), theme files (`--allow-theme`, the
  theme file itself checked against the roots) and embedded sources (`--allow-embed-source`). Only
  then does the tool option exist. Tool calls never pass a raw flag to rayomd: every flag comes
  from a typed, validated option.
- **Processes.** rayomd and the GUI are started with argument arrays, never through a shell. Warm
  `rayomd --serve --json` children serve the conversions, each one request at a time: the first
  starts once the client has initialized (when a rayomd binary is already here), a second only
  when a call finds the first busy, up to `--workers` (default one a CPU, at most 4); calls for one
  output file stay on one child, in order. A child that exits, breaks the protocol or does not
  answer within the timeout (60 s, `--timeout`) is stopped, that call fails, and the next call
  starts a new child. They end with the server.
- **Downloads.** Only the pinned release asset, only when its SHA-256 matches.

## Performance

Measured on 2026-11-04 on four pinned cores of an AMD Ryzen 5 PRO 4650GE in `node:22-alpine`
(Node.js 22.23), with the static `rayomd` and a raw JSON-RPC client over stdio, as a desktop
client talks to the server: the median of each run, the mean of two to four runs. *Before* is the
first commit of this repository with RayoMD `426e4ed`, the first `--serve --json`; *after* is
this one with RayoMD `b71ec98`, its vectorized request reader.

| Call | Before | After |
|---|---:|---:|
| Start until `initialize` is answered | 182 ms | **117 ms** |
| First `markdown_to_pdf` (tester.md), 300 ms after `initialize` | 18.2 ms | **3.8 ms** |
| Small Markdown text | 0.69 ms | **0.52 ms** |
| Small Markdown file | 0.53 ms | **0.44 ms** |
| 1.1 MB Markdown text | 30.5 ms | **21.5 ms** |
| 7.9 MB Markdown text | 606 ms | **142 ms** |
| 1.1 MB Markdown files, 8 calls in flight | 296 calls/s | **545 calls/s** |

Of a small call, rayomd converts for 0.05 ms; the rest is the SDK's handling of the messages and
the round trips through the pipes. What made the difference:

- **One file to load.** `dist/rayomd-mcp.mjs` is one minified bundle of the server, the SDK and
  zod: Node.js reads, resolves and compiles one module instead of some 150. Most of what remains
  is Node.js's own start (54 ms) and the SDK building its schemas.
- **A warm first call.** Once the client has initialized, the server starts the first `rayomd`
  and makes one call through a server of its own, in memory, into a temporary folder it deletes:
  the code of a call has run, its schemas are compiled and rayomd's fonts are loaded before the
  model's first call arrives.
- **Linear reads of large messages.** The SDK's stdio reader copies everything it holds for each
  64 KiB chunk and searches it from the start, and stops at 10 MB; [`src/stdio.ts`](src/stdio.ts)
  keeps a message's chunks and joins them once, up to rayomd's 32 MiB request line.
- **System calls instead of thread-pool trips** for the root checks, and no second check of a
  `source_path` that is the output's.
- **Several children** when calls overlap; one when they do not.
- **In rayomd:** the request reader of `--serve --json` reads strings 16 bytes a step (SSE2) and
  decodes escapes in blocks: a 1 MB request of Markdown parses in 0.3 ms instead of 2.75.

A 1 MB request still spends about 5 ms in `JSON.stringify` of the Markdown on its way to
`rayomd`: a raw-bytes frame would save it, at the cost of a stream that loses its place after a
malformed line, so the protocol stays JSON.

## Command line and environment

```
rayomd-mcp [--root DIR]... [--allow-url-images] [--allow-unsafe-local-images]
           [--allow-theme] [--allow-embed-source] [--timeout SECONDS] [--workers N]
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
import { exportArgs, RayomdPool, resolveRayomd } from 'rayomd-mcp/client';

const rayomd = new RayomdPool({ command: async () => ({ command: (await resolveRayomd()).path }) });
const record = await rayomd.request({ input: 'notes.md', output: 'notes.pdf', args: exportArgs({ toc: true }) });
console.log(record.status, record.pages);
await rayomd.close();
```

`RayomdServe` is one child on its own; the module also exports `runRayomd` (one command, no
shell), `downloadRelease`, `findOnPath`, `RELEASE_SHA256` and the archive readers.

## Development

```sh
npm ci
npm test                                        # build, unit tests against test/fake-rayomd.mjs
RAYOMD_TEST_BINARY=/path/to/rayomd npm test     # and the real-binary suite (byte-identical PDFs)
RAYOMD_PATH=/path/to/rayomd npm run smoke       # raw JSON-RPC over stdio against dist/rayomd-mcp.mjs
npm run sync-syntax -- ../rayomd/skills/rayomd/references/syntax.md
npm run pin-release -- 5.3.0                    # pin a release's asset hashes and download it by default
```

A change to the call path comes with before and after numbers, measured as above. A release:
bump `version` in `package.json` and both versions in `server.json`, tag `vX.Y.Z`;
[`release.yml`](.github/workflows/release.yml) publishes to npm with provenance and to the MCP
Registry.

## License

Apache-2.0, as RayoMD. See [LICENSE](LICENSE).

<p align="right"><a href="#readme-top">back to top ↑</a></p>
