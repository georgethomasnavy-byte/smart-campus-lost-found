-- Additive enum expansion for the existing campus lost-and-found schema.
-- Keep this migration separate from any SQL that uses the new enum labels:
-- PostgreSQL makes ALTER TYPE ... ADD VALUE visible only after this migration
-- commits. Existing profile and claim rows are not rewritten here.

DO $$
BEGIN
  CREATE TYPE public.campus_role AS ENUM ('student', 'faculty', 'staff');
EXCEPTION WHEN duplicate_object THEN NULL;
END;
$$;

ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'faculty' AFTER 'student';
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'staff' AFTER 'faculty';

ALTER TYPE public.claim_status ADD VALUE IF NOT EXISTS 'needs_info' AFTER 'pending';

ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'claim_needs_info' AFTER 'claim_submitted';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'item_handed_over' AFTER 'item_status';
