import { defineConfig } from "vite";

// Relative base so the same build works from the hub (/apps/<name>/) and inside an .ehpk package.
// dedupe: ../shared imports the SDK from outside this folder; resolve it from here.
export default defineConfig({ base: "./", build: { target: "es2020" }, resolve: { dedupe: ["@evenrealities/even_hub_sdk"] } });
