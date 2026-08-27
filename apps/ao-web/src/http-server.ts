import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import type { OperatorWebApplication } from './app.js';

export function createOperatorHttpServer(
  app: OperatorWebApplication,
  options: { readonly host: string; readonly port: number },
): Server {
  return createServer(async (request, response) => {
    try {
      const body = request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : await readBody(request);
      const webRequest = new Request(
        `http://${options.host}:${options.port}${request.url ?? '/'}`,
        {
          method: request.method,
          headers: requestHeaders(request.headers),
          ...(body ? { body } : {}),
        },
      );
      const webResponse = await app.handle(webRequest);
      response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
      response.end(Buffer.from(await webResponse.arrayBuffer()));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error('Operator request body exceeds 64 KiB');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function requestHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => {
    if (value === undefined) return [];
    return [[name, Array.isArray(value) ? value.join(', ') : value]];
  }));
}
