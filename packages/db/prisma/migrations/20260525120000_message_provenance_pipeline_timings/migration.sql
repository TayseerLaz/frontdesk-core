-- Phase 13 — per-station pipeline timing trace on every bot reply.
--
-- Adds `pipeline_timings` jsonb to message_provenances. Shape:
--   {
--     "totalMs": 4831,
--     "laps": [
--       { "station": "transcribe+gather (parallel)",  "durationMs": 1842, "cumulativeMs": 1842 },
--       { "station": "llm",                            "durationMs":  812, "cumulativeMs": 2654 },
--       { "station": "validators",                     "durationMs":   18, "cumulativeMs": 2672 },
--       { "station": "tts_synthesize",                 "durationMs":  640, "cumulativeMs": 3312 },
--       { "station": "ffmpeg_transcode",               "durationMs":  220, "cumulativeMs": 3532 },
--       { "station": "meta_media_upload",              "durationMs":  680, "cumulativeMs": 4212 },
--       { "station": "meta_messages_send",             "durationMs":  430, "cumulativeMs": 4642 },
--       { "station": "persist+provenance",             "durationMs":  189, "cumulativeMs": 4831 }
--     ]
--   }
--
-- Nullable so older provenance rows (pre-Phase-13) stay valid.

ALTER TABLE message_provenances
  ADD COLUMN IF NOT EXISTS pipeline_timings JSONB;
