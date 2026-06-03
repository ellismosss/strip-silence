// Allows importing .html files as strings (inlined by esbuild for the dialog UI).
declare module "*.html" {
  const content: string;
  export default content;
}
