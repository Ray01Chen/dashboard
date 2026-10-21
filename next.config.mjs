/** @type {import('next').NextConfig} */
const config = {
  // A production build must never replace files used by a running dev server.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
};

export default config;
