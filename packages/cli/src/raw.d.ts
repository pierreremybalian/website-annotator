// `?raw` imports: inlined as a string by build.mjs (esbuild) and natively by vitest.
declare module '*?raw' {
  const content: string;
  export default content;
}
