// The stdio transport of the server: the SDK's StdioServerTransport with a line buffer that holds
// each message's pieces once. The SDK's ReadBuffer copies everything buffered into a new Buffer for
// every chunk and searches it from the start each time, so a message of n bytes arriving in 64 KiB
// chunks costs O(n²): a 7.9 MB markdown_to_pdf call spent 0.9 s there, 47 ms for 1.1 MB
// (2026-11-04). Its limit is also 10 MB, below rayomd's 32 MiB request line.

import { deserializeMessage, ReadBuffer, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { MAX_REQUEST_BYTES } from './client/serve.js';

/** The longest message the server reads: rayomd's request line and room for the call around it. */
export const MAX_MESSAGE_BYTES = MAX_REQUEST_BYTES + 1024 * 1024;

/**
 * Splits a byte stream into JSON-RPC messages, each byte copied once: the pieces of an unfinished
 * line are kept as they came and joined when its line break arrives, and only new bytes are
 * searched for one. What the SDK's ReadBuffer does otherwise: a line that is not JSON is skipped,
 * a message over the limit clears the buffer and throws.
 */
export class LineReadBuffer extends ReadBuffer {
    private readonly maxBytes: number;
    private pieces: Buffer[] = [];
    private pending = 0;
    private readonly lines: Buffer[] = [];

    constructor(maxBytes = MAX_MESSAGE_BYTES) {
        super({ maxBufferSize: maxBytes });
        this.maxBytes = maxBytes;
    }

    override append(chunk: Buffer): void {
        let start = 0;
        for (;;) {
            const end = chunk.indexOf(10, start);
            const piece = chunk.subarray(start, end === -1 ? chunk.length : end);
            if (this.pending + piece.length > this.maxBytes) {
                this.clear();
                throw new Error(`ReadBuffer exceeded maximum size of ${this.maxBytes} bytes`);
            }
            if (end === -1) {
                if (piece.length > 0) {
                    this.pieces.push(piece);
                    this.pending += piece.length;
                }
                return;
            }
            this.lines.push(this.pieces.length === 0 ? piece : Buffer.concat([...this.pieces, piece], this.pending + piece.length));
            this.pieces = [];
            this.pending = 0;
            start = end + 1;
        }
    }

    override readMessage(): JSONRPCMessage | null {
        for (let line = this.lines.shift(); line !== undefined; line = this.lines.shift()) {
            const length = line.length > 0 && line[line.length - 1] === 13 ? line.length - 1 : line.length;
            try {
                return deserializeMessage(line.toString('utf8', 0, length));
            } catch (error) {
                if (error instanceof SyntaxError) continue;
                throw error;
            }
        }
        return null;
    }

    override clear(): void {
        this.pieces = [];
        this.pending = 0;
        this.lines.length = 0;
    }
}

/** StdioServerTransport on process.stdin and stdout, reading through a LineReadBuffer. */
export function lineStdioTransport(maxBytes = MAX_MESSAGE_BYTES): StdioServerTransport {
    const transport = new StdioServerTransport(undefined, undefined, { maxBufferSize: maxBytes });
    // The SDK (pinned) keeps its buffer in this private field and calls only append, readMessage
    // and clear on it. Should the field move, the SDK's own buffer stays; test/stdio.test.mjs sends
    // a message over its 10 MB limit, which then fails.
    if (Reflect.get(transport, '_readBuffer') instanceof ReadBuffer) Reflect.set(transport, '_readBuffer', new LineReadBuffer(maxBytes));
    return transport;
}
