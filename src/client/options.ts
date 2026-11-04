// Typed export options and the rayomd command-line flags they stand for (the CLI's
// ParseExportOptions, src/cli/main_cli.cpp).

export type Style = 'elegant' | 'modern' | 'tech';
export type HeadingLevel = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

export interface ExportOptions {
    style?: Style;
    /** compact, normal, wide, or margin=N with in (the default unit) or pt: margin=0.75in, margin=54pt. */
    margin?: string;
    /** a4, a3, a5, letter, legal (each also -landscape), WIDTHxHEIGHT in mm/cm/in/pt, or WIDTHxauto. */
    page_size?: string;
    toc?: boolean;
    /** Heading levels the table of contents lists, 1 to 6 (rayomd's default 3). */
    toc_depth?: number;
    /** Numbers before the headings of this many levels, 1 to 6. */
    number_headings?: number;
    page_numbers?: boolean;
    footnotes?: 'end' | 'page';
    dialect?: 'github' | 'obsidian';
    pdfa?: boolean;
    pdfua?: boolean;
    black_text?: boolean;
    /** false: code blocks in one colour (--no-highlight). */
    highlight_code?: boolean;
    /** false: ```mermaid blocks stay code (--no-diagrams). */
    diagrams?: boolean;
    /** A new page before each heading of level 1 to N. */
    page_break_before?: HeadingLevel;
    allow_url_images?: boolean;
    allow_unsafe_local_images?: boolean;
    embed_source?: boolean;
    /** Path of a theme file. */
    theme?: string;
}

function level(name: string, value: number): number {
    if (!Number.isInteger(value) || value < 1 || value > 6) throw new Error(`${name} must be an integer from 1 to 6`);
    return value;
}

/** The rayomd flags for `options`, in a fixed order; options left out add no flag. */
export function exportArgs(options: ExportOptions): string[] {
    const args: string[] = [];
    if (options.style !== undefined) args.push(options.style);
    if (options.margin !== undefined) args.push(options.margin);
    if (options.page_size !== undefined) args.push(`--page-size=${options.page_size}`);
    if (options.toc) args.push('--toc');
    if (options.toc_depth !== undefined) args.push(`--toc-depth=${level('toc_depth', options.toc_depth)}`);
    if (options.number_headings !== undefined) args.push(`--number-headings=${level('number_headings', options.number_headings)}`);
    if (options.page_numbers) args.push('--page-numbers');
    if (options.footnotes !== undefined) args.push(`--footnotes=${options.footnotes}`);
    if (options.dialect !== undefined) args.push(`--dialect=${options.dialect}`);
    if (options.pdfa) args.push('--pdfa');
    if (options.pdfua) args.push('--pdfua');
    if (options.black_text) args.push('--black-text');
    if (options.highlight_code === false) args.push('--no-highlight');
    if (options.diagrams === false) args.push('--no-diagrams');
    if (options.page_break_before !== undefined) args.push(`--page-break-before=${options.page_break_before}`);
    if (options.allow_url_images) args.push('--allow-url-images');
    if (options.allow_unsafe_local_images) args.push('--allow-unsafe-local-images');
    if (options.embed_source) args.push('--embed-source');
    if (options.theme !== undefined) args.push(`--theme=${options.theme}`);
    return args;
}
