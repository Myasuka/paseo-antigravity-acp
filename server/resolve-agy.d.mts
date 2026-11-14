export interface ResolvedAgyBinary {
  found: boolean;
  path: string | null;
  source: 'configured' | 'env' | 'path' | 'fallback' | 'none';
  checked: string[];
}

export interface ResolveAgyBinaryOptions {
  configuredPath?: string;
  env?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  homedirPath?: string;
}

export function expandHomePath(rawPath: string, home?: string): string;
export function resolveAgyBinary(options?: ResolveAgyBinaryOptions): ResolvedAgyBinary;
export function parseExtraReadRoots(rawValue: string | undefined): string[];
export function mergeReadOnlyRoots(baseRoots?: readonly string[], extraRoots?: readonly string[]): string[];
