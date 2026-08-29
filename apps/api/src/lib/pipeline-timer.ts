// Phase 13 — per-station pipeline timer.
//
// Threaded through maybeReplyAsBot. At every station boundary the
// caller calls .lap('station-name') which records:
//   - the time spent in the station that just finished
//   - the cumulative time since the stopwatch was constructed
//
// .snapshot() returns the structured trace that gets persisted into
// MessageProvenance.pipelineTimings — so the inbox provenance UI can
// render a per-station bar chart per reply.
//
// Stations we currently record (sequential unless noted):
//   - transcribe+gather  (parallel: Whisper download+transcribe || gatherBotData + draft-cart load)
//   - llm                (buildBotResponse → OpenAI or Groq)
//   - validators         (validateReply pipeline)
//   - image_attach       (per-image loop, recorded cumulatively with count)
//   - tts_synthesize     (Google or ElevenLabs)
//   - ffmpeg_transcode
//   - meta_media_upload  (audio media upload to Meta)
//   - meta_messages_send (POST /messages for the audio or text reply)
//   - persist+provenance (DB write of the bot message + recordProvenance fire-off)

export interface PipelineLap {
  station: string;
  durationMs: number;
  // Wall-clock time since the stopwatch was created. Lets the UI render
  // a stacked timeline without recomputing.
  cumulativeMs: number;
  // Optional metadata for stations with sub-events (e.g. image_attach
  // records how many images were attached).
  meta?: Record<string, unknown>;
}

export interface PipelineSnapshot {
  totalMs: number;
  laps: PipelineLap[];
}

export class PipelineStopwatch {
  private startedAt: number;
  private lastLapAt: number;
  private laps: PipelineLap[] = [];

  constructor() {
    this.startedAt = Date.now();
    this.lastLapAt = this.startedAt;
  }

  /**
   * Record the time spent in the station that just finished. The next
   * lap() call will measure from this point.
   */
  lap(station: string, meta?: Record<string, unknown>): void {
    const now = Date.now();
    this.laps.push({
      station,
      durationMs: now - this.lastLapAt,
      cumulativeMs: now - this.startedAt,
      ...(meta ? { meta } : {}),
    });
    this.lastLapAt = now;
  }

  /**
   * Snapshot of the timings so far. Safe to call multiple times — the
   * stopwatch keeps running and you can lap again after.
   */
  snapshot(): PipelineSnapshot {
    return {
      totalMs: Date.now() - this.startedAt,
      laps: [...this.laps],
    };
  }
}
