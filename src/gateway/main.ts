// Gateway sidecar of the celld pod. Run it with `node src/gateway/main.ts`; Node 24 removes the types.
import type { Server } from "node:http";
import { type ListenAddress, parseConfig } from "./config.ts";
import { createInjectProxy } from "./inject-proxy.ts";
import { createS3Shim } from "./s3-shim.ts";

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

function listen(server: Server, address: ListenAddress, name: string): void {
  server.listen(address.port, address.host, () => {
    console.log(`gateway: ${name} listens on ${address.host}:${address.port}`);
  });
}

const config = parseConfig(process.argv.slice(2), process.env);
const servers: Server[] = [];

if (config.s3 !== undefined) {
  const shim = createS3Shim(config.s3);
  listen(shim, config.s3.listen, `s3 shim to ${config.s3.upstream.origin}`);
  servers.push(shim);
}
const proxy = createInjectProxy(config.proxy);
listen(proxy, config.proxy.listen, "inject proxy");
servers.push(proxy);

for (const signal of SHUTDOWN_SIGNALS) {
  process.on(signal, () => {
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
  });
}
