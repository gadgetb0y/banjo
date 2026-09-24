import { and, eq, isNotNull, lt } from 'drizzle-orm';
import { config } from '../config/index.js';
import { db } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { callAttempts } from '../tasks/schema.js';
import { createTelephonyProvider } from '../telephony/factory.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Deletes call recordings older than `retentionDays` from the telephony
 * provider, then forgets their ids (#8). A recording the provider refuses to
 * delete keeps its id, so the next sweep tries again rather than losing track
 * of audio that still exists. 0 keeps everything. Returns how many went.
 */
export async function deleteExpiredRecordings(
  deleteRecording: (recordingId: string) => Promise<void>,
  retentionDays: number = config.RECORDING_RETENTION_DAYS,
  now: Date = new Date(),
): Promise<number> {
  if (retentionDays === 0) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * MS_PER_DAY);
  const expired = await db
    .select({ id: callAttempts.id, recordingSid: callAttempts.recordingSid })
    .from(callAttempts)
    .where(and(isNotNull(callAttempts.recordingSid), lt(callAttempts.startedAt, cutoff)));

  let deleted = 0;
  for (const { id, recordingSid } of expired) {
    try {
      await deleteRecording(recordingSid!);
      await db.update(callAttempts).set({ recordingSid: null }).where(eq(callAttempts.id, id));
      deleted++;
    } catch (err) {
      logger.error({ err, callAttemptId: id, recordingSid }, 'could not delete an expired call recording — will retry next sweep');
    }
  }
  return deleted;
}

/**
 * Retention runs at boot and then daily — even with RECORD_CALLS off, so
 * switching recording off doesn't keep what was already recorded forever.
 */
export function startRecordingRetentionSweeper(): void {
  const telephony = createTelephonyProvider();
  if (!telephony.deleteRecording) return;
  const deleteRecording = telephony.deleteRecording.bind(telephony);
  const sweep = () =>
    deleteExpiredRecordings(deleteRecording)
      .then((count) => {
        if (count > 0) logger.info({ count, retentionDays: config.RECORDING_RETENTION_DAYS }, 'deleted expired call recordings');
      })
      .catch((err) => logger.error({ err }, 'recording retention sweep failed'));
  void sweep();
  setInterval(sweep, MS_PER_DAY).unref();
}
