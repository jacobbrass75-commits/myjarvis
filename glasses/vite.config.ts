import { defineConfig } from "vite";

// Relative base: works when the hub serves it at /glasses/ and inside an .ehpk package.
export default defineConfig({ base: "./", build: { target: "es2020" } });
