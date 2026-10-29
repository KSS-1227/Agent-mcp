/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Ensure we can safely import pg or handle server components
  serverExternalPackages: ["pg"],
};

export default nextConfig;

