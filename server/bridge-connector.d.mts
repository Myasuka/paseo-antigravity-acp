import type { AcpStream } from '@getpaseo/plugin/server/acp';

export interface AgyBridgeStreamOptions {
  env?: NodeJS.ProcessEnv;
  defaultReadOnlyRoots?: readonly string[];
}

export function createAgyBridgeStream(options?: AgyBridgeStreamOptions): AcpStream;
