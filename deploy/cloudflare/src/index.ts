import { Container, ContainerProxy } from '@cloudflare/containers';
import { RelayDatabase } from './database';
export { RelayDatabase };
export { ContainerProxy };

interface Env {
  RELAY: DurableObjectNamespace<RelayContainer>;
  RELAY_DB: DurableObjectNamespace<RelayDatabase>;
  PUBLIC_URL: string;
  BRC_ADMIN_USER: string;
  BRC_ADMIN_PASSWORD: string;
  BRC_SESSION_SECRET: string;
}

// A single named relay keeps live device WebSockets and MCP calls together.
// Disk is deliberately not authoritative: ALL SQL goes to RelayDatabase.
export class RelayContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = '10m';
  enableInternet = false;
  allowedHosts = ['brc-storage'];
  envVars = {
    NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '3000', TRUST_PROXY: 'true',
    PUBLIC_URL: this.env.PUBLIC_URL,
    BRC_ADMIN_USER: this.env.BRC_ADMIN_USER,
    BRC_ADMIN_PASSWORD: this.env.BRC_ADMIN_PASSWORD,
    BRC_SESSION_SECRET: this.env.BRC_SESSION_SECRET,
    BRC_SQL_ENDPOINT: 'http://brc-storage',
  };
}

// This host exists only inside Cloudflare's container egress network. There is
// intentionally no public SQL route, storage token, or exposed database port.
RelayContainer.outboundByHost = {
  'brc-storage': (request, env: Env) => env.RELAY_DB.getByName('primary').fetch(request),
};


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.PUBLIC_URL || !env.BRC_ADMIN_PASSWORD || !env.BRC_SESSION_SECRET || env.BRC_SESSION_SECRET.length < 32) {
      return new Response('Relay configuration incomplete', { status: 503 });
    }
    const expected = new URL(env.PUBLIC_URL);
    if (expected.protocol !== 'https:' || new URL(request.url).origin !== expected.origin) return new Response('Unknown origin', { status: 421 });
    // Never trust client-supplied forwarding headers. Preserve only the edge IP.
    const headers = new Headers(request.headers);
    headers.delete('forwarded');
    headers.set('x-forwarded-for', request.headers.get('cf-connecting-ip') ?? '127.0.0.1');
    headers.set('x-forwarded-proto', 'https');
    headers.set('x-forwarded-host', expected.host);
    return env.RELAY.getByName('primary').fetch(new Request(request, { headers }));
  },
};
