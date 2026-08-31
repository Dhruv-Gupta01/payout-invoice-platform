// `to-words` ships types only under package.json "exports" subpaths that
// TS's classic "node" module resolution can't follow (needs "bundler" or
// "node16"+, which isn't safe to switch to for this CommonJS server — see
// tests/amountInWords.test.ts). Runtime import already works fine (proven
// by that test); this just gives tsc a type for the small surface actually
// used in src/invoices/amountInWords.ts.
declare module "to-words" {
  export interface ToWordsOptions {
    localeCode?: string;
    converterOptions?: {
      currency?: boolean;
      ignoreDecimal?: boolean;
      ignoreZeroCurrency?: boolean;
      doNotAddOnly?: boolean;
    };
  }

  export class ToWords {
    constructor(options?: ToWordsOptions);
    convert(amount: number): string;
  }
}
