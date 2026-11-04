// One tool call through a server of its own, in memory, as a client would make it: initialize,
// notifications/initialized, tools/call. RayomdMcp.warm uses it so that the code of a call (the
// SDK's, zod's parsers of the tool's schemas, rayomd's) has run once before the first real call:
// the first tester.md call took 24 ms after start, the next ones 4 (2026-11-04).

import { InMemoryTransport, type JSONRPCMessage, type McpServer } from '@modelcontextprotocol/server';

export async function callInMemory(server: McpServer, name: string, args: Record<string, unknown>): Promise<void> {
    const [client, transport] = InMemoryTransport.createLinkedPair();
    const answers = new Map<number, () => void>();
    client.onmessage = (message: JSONRPCMessage) => {
        if ('id' in message && typeof message.id === 'number') answers.get(message.id)?.();
    };
    await server.connect(transport);
    await client.start();
    const request = (id: number, method: string, params: Record<string, unknown>) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        answers.set(id, resolve);
        void client.send({ jsonrpc: '2.0', id, method, params });
        return promise;
    };
    try {
        await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rayomd-mcp-warm', version: '1' } });
        await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        await request(2, 'tools/call', { name, arguments: args });
    } finally {
        await server.close();
    }
}
