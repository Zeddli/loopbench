import type { NextConfig } from "next";
// Allow dev assets only through the explicitly configured operator gateway.
// API mutation origin checks remain independent and production is unchanged.
const allowedDevOrigins: string[] = [];
if (process.env.LOOPBENCH_GATEWAY_ORIGIN) {
  const gateway = new URL(process.env.LOOPBENCH_GATEWAY_ORIGIN);
  if (gateway.protocol === "https:" && !gateway.username && !gateway.password)
    allowedDevOrigins.push(gateway.hostname);
}
const config: NextConfig = {
  allowedDevOrigins,
  // Deployment provisions private state and the approved manifest separately.
  outputFileTracingExcludes: {
    "/*": ["./.env*", "./.loopbench/**/*", "./sandbox/pi/runner-manifest.json"],
  },
};
export default config;
