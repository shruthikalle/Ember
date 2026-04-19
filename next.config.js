/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['dotenv', 'better-sqlite3'],
  // Turbopack config (Next.js 15+ uses Turbopack by default)
  turbopack: {},
  webpack: (config, { isServer, webpack }) => {
    // Handle Node.js modules that shouldn't be bundled for client
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        crypto: false,
        stream: false,
        url: false,
        zlib: false,
        http: false,
        https: false,
        assert: false,
        os: false,
        path: false,
        // dotenv should not be bundled for client
        'dotenv': false,
      };
      
      // Ignore dotenv in client-side bundle
      config.plugins.push(
        new webpack.IgnorePlugin({
          resourceRegExp: /^dotenv$/,
        })
      );
    }
    return config;
  },
}

export default nextConfig
