// The package uses module.exports, but its bundled default-export declaration is incompatible with NodeNext.
declare module "robots-parser" {
  function parse(url: string, text: string): {
    isAllowed(url: string, userAgent?: string): boolean | undefined;
    getCrawlDelay(userAgent?: string): number | undefined;
  };
  export = parse;
}
