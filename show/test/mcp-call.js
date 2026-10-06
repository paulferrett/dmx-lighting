// Call one of mcp.js's tools over stdio, the way Claude Code does.
//   node test/mcp-call.js <tool> '<json args>' [image-out.jpg]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [name, json = '{}', imageOut] = process.argv.slice(2);
const client = new Client({ name: 'mcp-call', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../mcp.js', import.meta.url))] }));
if (!name) {
  const { tools } = await client.listTools();
  for (const t of tools) console.log(t.name.padEnd(18), t.title);
} else {
  const r = await client.callTool({ name, arguments: JSON.parse(json) });
  for (const c of r.content) {
    if (c.type === 'text') console.log(c.text);
    if (c.type === 'image') { const out = imageOut ?? 'snapshot.jpg'; writeFileSync(out, Buffer.from(c.data, 'base64')); console.log(`[image → ${out}]`); }
  }
  if (r.isError) process.exitCode = 1;
}
await client.close();
