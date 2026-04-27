import { pathToFileURL } from "node:url";
import { buildApp } from "./http/app.js";

async function main() {
  const app = await buildApp();
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.FASTIFY_HOST ?? "0.0.0.0";
  await app.listen({ port, host });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { buildApp };

