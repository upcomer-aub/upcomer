import type { NextConfig } from "next";

const config: NextConfig = {
  // PDF.js loads its worker beside its own package in the Node runtime.
  serverExternalPackages: ["pdfjs-dist"],
};

export default config;
