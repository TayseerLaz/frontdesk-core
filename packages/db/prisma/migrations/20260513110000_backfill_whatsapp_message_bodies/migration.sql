-- Backfill body text on existing whatsapp_messages rows that were
-- persisted with placeholder strings like '[button]', '[interactive]',
-- or '[image]' before the inbound-body extractor was fixed.
--
-- For each affected row we try to recover the actual user-facing text
-- from the stored raw_payload JSON. Looks for, in priority order:
--   * text.body                              (plain text inbound)
--   * button.text  / button.payload          (template Quick Reply)
--   * interactive.button_reply.title         (interactive button)
--   * interactive.list_reply.title           (interactive list)
--   * image|video|document|audio.caption     (media with caption)
-- Falls back to the existing body when nothing matches (so we never
-- nuke a row's body unexpectedly).

UPDATE whatsapp_messages
SET body = COALESCE(
  NULLIF(raw_payload -> 'text' ->> 'body', ''),
  NULLIF(raw_payload -> 'button' ->> 'text', ''),
  NULLIF(raw_payload -> 'button' ->> 'payload', ''),
  NULLIF(raw_payload -> 'interactive' -> 'button_reply' ->> 'title', ''),
  NULLIF(raw_payload -> 'interactive' -> 'list_reply' ->> 'title', ''),
  NULLIF(raw_payload -> 'image' ->> 'caption', ''),
  NULLIF(raw_payload -> 'video' ->> 'caption', ''),
  NULLIF(raw_payload -> 'document' ->> 'caption', ''),
  NULLIF(raw_payload -> 'audio' ->> 'caption', ''),
  body
)
WHERE direction = 'inbound'
  AND raw_payload IS NOT NULL
  AND (
    body LIKE '[%]'
    OR body IS NULL
  );

-- Also recompute thread previews so the inbox shows the right text
-- in the conversation list instead of the stale "[button]" preview.
UPDATE whatsapp_threads t
SET last_message_preview = LEFT(m.body, 200)
FROM (
  SELECT DISTINCT ON (thread_id) thread_id, body, received_at
  FROM whatsapp_messages
  WHERE thread_id IS NOT NULL AND body IS NOT NULL
  ORDER BY thread_id, received_at DESC
) m
WHERE t.id = m.thread_id
  AND (t.last_message_preview LIKE '[%]' OR t.last_message_preview IS NULL);
