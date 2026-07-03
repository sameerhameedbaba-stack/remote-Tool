/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle so the Docker image can run without
  // the full node_modules tree. See infra/docker-compose.yml + Dockerfile.
  output: "standalone",
};

export default nextConfig;
