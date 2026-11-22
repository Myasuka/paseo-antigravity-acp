import type { AcpStream } from '@getpaseo/plugin/server/acp';

export interface AgyBridgeStreamOptions {
  env?: NodeJS.ProcessEnv;
  defaultReadOnlyRoots?: readonly string[];
  onClose?: () => void;
}

export interface AgyBridgeStream extends AcpStream {
  canSteer(sessionId: string): boolean;
  steer(sessionId: string, prompt: readonly unknown[]): Promise<boolean>;
}

export function createAgyBridgeStream(options?: AgyBridgeStreamOptions): AgyBridgeStream;
