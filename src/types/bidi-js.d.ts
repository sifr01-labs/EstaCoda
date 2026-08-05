declare module "bidi-js" {
  export type BidiDirection = "ltr" | "rtl";

  export type BidiEmbeddingLevels = {
    readonly levels: Uint8Array;
    readonly paragraphs: readonly {
      readonly start: number;
      readonly end: number;
      readonly level: number;
    }[];
  };

  export type BidiApi = {
    getEmbeddingLevels(text: string, direction?: BidiDirection): BidiEmbeddingLevels;
    getReorderedIndices(
      text: string,
      embeddingLevels: BidiEmbeddingLevels,
      start?: number,
      end?: number
    ): number[];
  };

  export default function createBidi(): BidiApi;
}
