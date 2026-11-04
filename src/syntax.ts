// The rayomd://syntax resource (resources/syntax.md, the RayoMD skill's syntax reference) and the
// short form of it that markdown_to_pdf's description carries.

import { readFileSync } from 'node:fs';

export const SYNTAX_URI = 'rayomd://syntax';

/** The full reference, read once from the package's resources folder. */
export function syntaxReference(): string {
    return readFileSync(new URL('../resources/syntax.md', import.meta.url), 'utf8');
}

export const SYNTAX_SHORT = [
    'Renders: GitHub Markdown (tables, task lists, footnotes, alerts > [!NOTE]), PNG/JPEG/SVG images',
    'with alt text (relative paths inside the Markdown file\'s folder), TeX math ($...$, $$...$$ on',
    'own lines, ```math), ```mermaid flowchart/graph, sequenceDiagram and pie, code colouring in 29',
    'languages, page breaks (\\pagebreak, <!-- pagebreak -->), [TOC], YAML front matter (title,',
    'author, lang) as PDF metadata. Degrades: CSS/HTML layout (text kept), LaTeX packages and',
    'macros, other Mermaid types (printed as code), SVGs needing scripts. Full list: resource',
    `${SYNTAX_URI}.`,
].join(' ');
