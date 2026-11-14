import type { AcpTransformer } from '@getpaseo/plugin/server/acp';

// AGY can report status=failed without rawOutput. Ensure failed tool snapshots always carry an error object.
export const failedToolErrors: AcpTransformer = {
  toolCall(snapshot) {
    if (snapshot.status === 'failed' && snapshot.output == null) {
      return { ...snapshot, output: { message: 'AGY reported a failed tool call without error details.' } };
    }
    return snapshot;
  },
};
