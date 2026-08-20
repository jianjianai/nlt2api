declare module "json-source-map" {
  export interface JsonSourceMapPosition {
    line: number;
    column: number;
    pos: number;
  }

  export interface JsonSourceMapPointer {
    key?: JsonSourceMapPosition;
    keyEnd?: JsonSourceMapPosition;
    value?: JsonSourceMapPosition;
    valueEnd?: JsonSourceMapPosition;
  }

  export interface JsonSourceMap {
    data: unknown;
    pointers: Record<string, JsonSourceMapPointer>;
  }

  export function parse(json: string): JsonSourceMap;
}
