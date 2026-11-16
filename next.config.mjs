/** @type {import('next').NextConfig} */
const nextConfig = {
  // Native / WASM-heavy packages must stay external to the server bundle.
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node", "sharp", "mysql2"],
  poweredByHeader: false,
};
export default nextConfig;
