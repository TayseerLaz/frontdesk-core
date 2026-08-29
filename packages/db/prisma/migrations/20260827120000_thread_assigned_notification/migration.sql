-- Inbox teamwork (F6): notification kind for "a conversation was assigned to
-- you". ADD VALUE must run alone in its own migration (house invariant #4).
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'thread_assigned';
