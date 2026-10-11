-- ============================================================================
-- Smart Campus Lost & Found · additive security/workflow migration
-- ============================================================================
-- Adds campus roles, richer public search fields, private verification data,
-- an intentionally limited public claim-history view, auditable claim review,
-- and a database-enforced handover operation. Existing reports and claims are
-- retained. Apply migrations in filename order.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- These SECURITY DEFINER helpers are trigger/function internals, not public
-- RPCs. Their default PostgreSQL EXECUTE privilege must not let a caller forge
-- notifications or audit rows for other users.
REVOKE ALL ON FUNCTION public.create_notification(
  uuid, text, text, public.notification_type, uuid, uuid
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.write_activity_log(
  uuid, text, text, uuid, jsonb
) FROM PUBLIC, anon, authenticated;

-- Retain a member's campus identity while the separate effective role grants
-- or removes administrator privileges. Legacy administrators default to
-- student because their former campus role was not stored in the old schema.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS campus_role public.campus_role;

UPDATE public.profiles
SET campus_role = CASE
  WHEN role = 'faculty' THEN 'faculty'::public.campus_role
  WHEN role = 'staff' THEN 'staff'::public.campus_role
  ELSE 'student'::public.campus_role
END
WHERE campus_role IS NULL;

ALTER TABLE public.profiles
  ALTER COLUMN campus_role SET DEFAULT 'student',
  ALTER COLUMN campus_role SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 1. Public item fields and server-side search indexes
-- ---------------------------------------------------------------------------
ALTER TABLE public.items
  ADD COLUMN IF NOT EXISTS keywords text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS identifying_characteristics text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS collection_instructions text,
  ADD COLUMN IF NOT EXISTS handed_over_at timestamptz,
  ADD COLUMN IF NOT EXISTS handed_over_by uuid REFERENCES public.profiles (user_id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_items_keywords_length') THEN
    ALTER TABLE public.items ADD CONSTRAINT chk_items_keywords_length
      CHECK (char_length(keywords) <= 250);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_items_characteristics_length') THEN
    ALTER TABLE public.items ADD CONSTRAINT chk_items_characteristics_length
      CHECK (char_length(identifying_characteristics) <= 500);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_items_collection_instructions_length') THEN
    ALTER TABLE public.items ADD CONSTRAINT chk_items_collection_instructions_length
      CHECK (collection_instructions IS NULL OR char_length(trim(collection_instructions)) BETWEEN 10 AND 500);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_items_handover_pair') THEN
    ALTER TABLE public.items ADD CONSTRAINT chk_items_handover_pair
      CHECK ((handed_over_at IS NULL) = (handed_over_by IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_items_handover_reporter') THEN
    ALTER TABLE public.items ADD CONSTRAINT chk_items_handover_reporter
      CHECK (handed_over_by IS NULL OR handed_over_by = reported_by);
  END IF;
END;
$$;

COMMENT ON COLUMN public.items.location IS
  'General, public campus area only. Exact found locations are stored in item_private_details.';
COMMENT ON COLUMN public.items.collection_instructions IS
  'Public pickup location/method for a found item; never used for private ownership verification.';
COMMENT ON COLUMN public.items.handed_over_at IS
  'Timestamp set only by confirm_item_handover after the finder confirms a physical handover.';

-- Replace the old generated vector with one that includes all public search
-- fields. It deliberately excludes exact locations, claim answers and notes.
DROP INDEX IF EXISTS public.idx_items_search_vector;
ALTER TABLE public.items DROP COLUMN IF EXISTS search_vector;
ALTER TABLE public.items
  ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      concat_ws(
        ' ',
        coalesce(title, ''),
        coalesce(keywords, ''),
        coalesce(description, ''),
        coalesce(identifying_characteristics, ''),
        coalesce(location, ''),
        replace(category::text, '_', ' ')
      )
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_items_search_vector
  ON public.items USING gin (search_vector);
CREATE INDEX IF NOT EXISTS idx_items_category
  ON public.items (category);

-- The earlier same-named index was a btree over lower(title), which did not
-- help substring searches. Replace it with trigram indexes used by ILIKE.
DROP INDEX IF EXISTS public.idx_items_title_trgm;
CREATE INDEX idx_items_title_trgm ON public.items USING gin (lower(title) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_items_description_trgm
  ON public.items USING gin (lower(description) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_items_location_trgm
  ON public.items USING gin (lower(location) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_items_keywords_trgm
  ON public.items USING gin (lower(keywords) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_items_characteristics_trgm
  ON public.items USING gin (lower(identifying_characteristics) gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 2. Private verification records and claim review audit history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.item_private_details (
  item_id uuid PRIMARY KEY REFERENCES public.items (id) ON DELETE CASCADE,
  exact_found_location text NOT NULL
    CHECK (char_length(trim(exact_found_location)) BETWEEN 3 AND 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.item_private_details IS
  'Private finder-entered exact discovery location. Not part of items, listings, search, or notifications.';

CREATE TABLE IF NOT EXISTS public.claim_review_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims (id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.items (id) ON DELETE CASCADE,
  reviewed_by uuid REFERENCES public.profiles (user_id) ON DELETE SET NULL,
  from_status public.claim_status NOT NULL,
  to_status public.claim_status NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claim_review_history_claim
  ON public.claim_review_history (claim_id, created_at DESC);

COMMENT ON TABLE public.claim_review_history IS
  'Append-only, private audit of administrative claim decisions; visible to administrators only.';

ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS lost_location_answer text NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_claim_lost_location_answer_length') THEN
    -- Empty is retained only for pre-migration claims. New submissions are
    -- independently required to provide a 3–500 character answer by RLS.
    ALTER TABLE public.claims ADD CONSTRAINT chk_claim_lost_location_answer_length
      CHECK (lost_location_answer = '' OR char_length(trim(lost_location_answer)) BETWEEN 3 AND 500);
  END IF;
END;
$$;

COMMENT ON COLUMN public.claims.lost_location_answer IS
  'Private claimant answer to where they believe they lost the item. Never exposed by claim_history or search.';

-- Preserve the old unique rule's intent (one active claim per person/item)
-- while allowing a person to submit a new claim after a previous one is closed.
ALTER TABLE public.claims DROP CONSTRAINT IF EXISTS uq_claim_per_user_item;
CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_active_per_user_item
  ON public.claims (item_id, claimant_id)
  WHERE status IN ('pending', 'needs_info', 'approved');

-- The old trigger marked every approved claim returned immediately. That was
-- an approval, not evidence of a physical handover. Preserve the claims and
-- move legacy approved reports back to the awaiting-handover state.
INSERT INTO public.claim_review_history
  (claim_id, item_id, reviewed_by, from_status, to_status, notes, created_at)
SELECT c.id, c.item_id, c.reviewed_by, 'pending', c.status,
       c.admin_notes, coalesce(c.reviewed_at, c.updated_at, c.created_at)
FROM public.claims c
WHERE c.status IN ('approved', 'rejected')
  AND c.reviewed_by IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.claim_review_history h
    WHERE h.claim_id = c.id
      AND h.to_status = c.status
      AND h.created_at = coalesce(c.reviewed_at, c.updated_at, c.created_at)
  );

-- Retain one prior approval if a legacy installation already contains
-- conflicting approvals. Other claim rows are retained as needs_info so staff
-- can re-review them; none is silently deleted or treated as verified.
WITH ranked AS (
  SELECT id, item_id,
         row_number() OVER (
           PARTITION BY item_id
           ORDER BY reviewed_at ASC NULLS LAST, created_at ASC, id ASC
         ) AS approval_rank
  FROM public.claims
  WHERE status = 'approved'
), conflicts AS (
  SELECT c.id, c.item_id, c.reviewed_by, c.admin_notes
  FROM public.claims c
  JOIN ranked r ON r.id = c.id
  WHERE r.approval_rank > 1
)
INSERT INTO public.claim_review_history
  (claim_id, item_id, reviewed_by, from_status, to_status, notes, created_at)
SELECT id, item_id, NULL, 'approved', 'needs_info',
       concat_ws(' ', nullif(admin_notes, ''),
         'Legacy conflicting approval found during migration; administrator review is required.'),
       now()
FROM conflicts;

SELECT set_config('app.internal_write', 'on', true);
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY item_id
           ORDER BY reviewed_at ASC NULLS LAST, created_at ASC, id ASC
         ) AS approval_rank
  FROM public.claims
  WHERE status = 'approved'
)
UPDATE public.claims c
SET status = 'needs_info',
    admin_notes = concat_ws(' ', nullif(c.admin_notes, ''),
      'Legacy conflicting approval found during migration; administrator review is required.'),
    reviewed_by = NULL,
    reviewed_at = NULL
FROM ranked r
WHERE r.id = c.id AND r.approval_rank > 1;
SELECT set_config('app.internal_write', 'off', true);

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_approved_claim_per_item
  ON public.claims (item_id)
  WHERE status = 'approved';

-- Legacy `returned` was sometimes assigned at claim approval or moderation,
-- with no evidence of a physical handover. Never preserve that as confirmed:
-- approved found claims become `claimed`; every other legacy returned row is
-- reopened as `active`. No timestamp or confirmer is fabricated.
SELECT set_config('app.internal_write', 'on', true);
UPDATE public.items i
SET status = CASE
      WHEN i.type = 'found' AND EXISTS (
        SELECT 1 FROM public.claims c
        WHERE c.item_id = i.id AND c.status = 'approved'
      ) THEN 'claimed'::public.item_status
      ELSE 'active'::public.item_status
    END,
    resolved_at = NULL
WHERE i.status = 'returned'
  AND i.handed_over_at IS NULL;
SELECT set_config('app.internal_write', 'off', true);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_returned_requires_handover'
      AND conrelid = 'public.items'::regclass
  ) THEN
    ALTER TABLE public.items ADD CONSTRAINT chk_returned_requires_handover
      CHECK (status <> 'returned' OR (handed_over_at IS NOT NULL AND handed_over_by IS NOT NULL));
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Campus roles are selected at sign-up, but admin is never user-selectable
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_name text;
  v_phone text;
  v_requested_role text;
  v_role public.user_role;
BEGIN
  v_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
    split_part(new.email, '@', 1)
  );
  IF char_length(v_name) < 3 THEN
    v_name := v_name || '_user';
  END IF;

  v_phone := nullif(trim(new.raw_user_meta_data ->> 'phone'), '');
  v_requested_role := lower(trim(coalesce(new.raw_user_meta_data ->> 'campus_role', '')));
  v_role := CASE v_requested_role
    WHEN 'faculty' THEN 'faculty'::public.user_role
    WHEN 'staff' THEN 'staff'::public.user_role
    WHEN 'student' THEN 'student'::public.user_role
    ELSE 'student'::public.user_role
  END;
  -- Even a direct Auth request that submits campus_role=admin becomes student.
  IF v_requested_role = 'admin' THEN
    v_role := 'student';
  END IF;

  INSERT INTO public.profiles (user_id, full_name, email, role, campus_role, phone)
  VALUES (new.id, left(v_name, 80), new.email, v_role,
          v_role::text::public.campus_role, left(v_phone, 20))
  ON CONFLICT (user_id) DO NOTHING;

  PERFORM public.write_activity_log(new.id, 'user_registered', 'profile', new.id,
    jsonb_build_object('campus_role', v_role));
  RETURN new;
END;
$$;

DROP POLICY IF EXISTS profiles_insert_self_as_student ON public.profiles;
DROP POLICY IF EXISTS profiles_insert_admin ON public.profiles;
DROP POLICY IF EXISTS profiles_insert_self_campus_role ON public.profiles;
CREATE POLICY profiles_insert_self_campus_role ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND role IN ('student', 'faculty', 'staff')
    AND campus_role::text = role::text
  );

-- Members may edit their own display name/phone only. Role and campus_role
-- changes go through set_profile_role(), which checks admin, audit, and
-- last-admin rules inside PostgreSQL.
REVOKE UPDATE, DELETE ON public.profiles FROM authenticated;
GRANT UPDATE (full_name, phone) ON public.profiles TO authenticated;
DROP POLICY IF EXISTS profiles_delete_admin ON public.profiles;

CREATE OR REPLACE FUNCTION public.guard_profile_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF public.internal_write() THEN
    RETURN new;
  END IF;

  IF new.role IS DISTINCT FROM old.role
     OR new.campus_role IS DISTINCT FROM old.campus_role THEN
    IF old.user_id = auth.uid() THEN
      RAISE EXCEPTION 'You cannot change your own campus role or administrator privileges.'
        USING errcode = '42501';
    END IF;
    IF NOT public.is_admin() THEN
      RAISE EXCEPTION 'Only an administrator may change a role.'
        USING errcode = '42501';
    END IF;
  END IF;

  IF NOT public.is_admin() THEN
    IF new.user_id IS DISTINCT FROM old.user_id THEN
      RAISE EXCEPTION 'Changing the account link is not allowed.' USING errcode = '42501';
    END IF;
    IF new.email IS DISTINCT FROM old.email THEN
      RAISE EXCEPTION 'E-mail addresses cannot be changed here.' USING errcode = '42501';
    END IF;
  END IF;

  IF old.role = 'admin' AND new.role <> 'admin' THEN
    PERFORM pg_advisory_xact_lock(20261010, 2);
    IF (SELECT count(*) FROM public.profiles WHERE role = 'admin') <= 1 THEN
      RAISE EXCEPTION 'The last administrator cannot be demoted.' USING errcode = '42501';
    END IF;
  END IF;
  RETURN new;
END;
$$;

CREATE OR REPLACE FUNCTION public.audit_profile_role_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF new.role IS DISTINCT FROM old.role
     OR new.campus_role IS DISTINCT FROM old.campus_role THEN
    PERFORM public.write_activity_log(
      auth.uid(), 'profile_role_changed', 'profile', new.user_id,
      jsonb_build_object(
        'from_role', old.role, 'to_role', new.role,
        'from_campus_role', old.campus_role, 'to_campus_role', new.campus_role
      )
    );
  END IF;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_role_audit ON public.profiles;
CREATE TRIGGER trg_profiles_role_audit
  AFTER UPDATE OF role, campus_role ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.audit_profile_role_change();

-- Remove the legacy self-service bootstrap RPC. The first administrator must
-- be provisioned out of band by the trusted Supabase project owner; later role
-- changes use this administrator-only, audited function.
DROP FUNCTION IF EXISTS public.bootstrap_first_admin();

DROP FUNCTION IF EXISTS public.set_profile_role(uuid, public.user_role);
DROP FUNCTION IF EXISTS public.set_profile_role(uuid, public.user_role, text);
CREATE OR REPLACE FUNCTION public.set_profile_role(
  p_user_id uuid,
  p_role public.user_role,
  p_notes text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target_role public.user_role;
  v_admin_count bigint;
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Administrator access required.' USING errcode = '42501';
  END IF;
  IF char_length(coalesce(v_notes, '')) > 500 THEN
    RAISE EXCEPTION 'Role-change notes must be no longer than 500 characters.' USING errcode = '22023';
  END IF;
  IF p_user_id IS NULL OR p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Administrators cannot change their own role.' USING errcode = '42501';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('student', 'faculty', 'staff', 'admin') THEN
    RAISE EXCEPTION 'Choose a valid campus role or administrator.' USING errcode = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(20261010, 2);
  SELECT role INTO v_target_role FROM public.profiles WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No profile found for the requested account.' USING errcode = 'P0002';
  END IF;

  IF v_target_role = 'admin' AND p_role <> 'admin' THEN
    SELECT count(*) INTO v_admin_count FROM public.profiles WHERE role = 'admin';
    IF v_admin_count <= 1 THEN
      RAISE EXCEPTION 'The last administrator cannot be demoted.' USING errcode = '42501';
    END IF;
  END IF;

  PERFORM set_config('app.internal_write', 'on', true);
  IF p_role = 'admin' THEN
    -- Preserve campus_role so demotion restores the member's actual role.
    UPDATE public.profiles SET role = 'admin' WHERE user_id = p_user_id;
  ELSE
    UPDATE public.profiles
       SET role = p_role,
           campus_role = p_role::text::public.campus_role
     WHERE user_id = p_user_id;
  END IF;
  PERFORM set_config('app.internal_write', 'off', true);
  PERFORM public.write_activity_log(
    auth.uid(), 'admin_profile_role_changed', 'profile', p_user_id,
    jsonb_build_object('from_role', v_target_role, 'to_role', p_role, 'reason', v_notes)
  );
END;
$$;

COMMENT ON FUNCTION public.set_profile_role(uuid, public.user_role, text) IS
  'Administrator-only role change. Admin promotion preserves campus_role; demotion restores the selected campus role.';
REVOKE ALL ON FUNCTION public.set_profile_role(uuid, public.user_role, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_profile_role(uuid, public.user_role, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Sensitive-data access rules and the intentionally safe public history
-- ---------------------------------------------------------------------------
ALTER TABLE public.item_private_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_review_history ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.item_private_details FROM PUBLIC, anon;
GRANT SELECT ON public.item_private_details TO authenticated;
DROP POLICY IF EXISTS item_private_details_select_finder_or_admin ON public.item_private_details;
CREATE POLICY item_private_details_select_finder_or_admin ON public.item_private_details
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.items i
      WHERE i.id = item_private_details.item_id
        AND i.reported_by = auth.uid()
    )
  );

REVOKE ALL ON public.claim_review_history FROM PUBLIC, anon;
GRANT SELECT ON public.claim_review_history TO authenticated;
DROP POLICY IF EXISTS claim_review_history_select_admin ON public.claim_review_history;
CREATE POLICY claim_review_history_select_admin ON public.claim_review_history
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- Extend the existing public profile view only with the non-sensitive campus
-- role. E-mail and phone remain absent.
CREATE OR REPLACE VIEW public.profiles_public AS
SELECT user_id, full_name, role, campus_role FROM public.profiles;
COMMENT ON VIEW public.profiles_public IS
  'Public-safe profile slice: display name, effective role and campus role only; no e-mail or phone.';
REVOKE ALL ON public.profiles_public FROM PUBLIC;
GRANT SELECT ON public.profiles_public TO anon, authenticated;

-- The view exposes only fields explicitly approved for public claim history.
-- Drop before recreating because the campus_role enum type is newly introduced.
DROP VIEW IF EXISTS public.claim_history;
CREATE VIEW public.claim_history WITH (security_barrier = true) AS
SELECT c.id,
       c.item_id,
       p.full_name AS claimant_name,
       p.campus_role,
       c.created_at AS claim_date,
       c.status
FROM public.claims c
JOIN public.profiles p ON p.user_id = c.claimant_id;

COMMENT ON VIEW public.claim_history IS
  'Public-safe claim transparency: display name, campus role, date and current status only. No claim text, location answer, contacts or admin notes.';
REVOKE ALL ON public.claim_history FROM PUBLIC;
GRANT SELECT ON public.claim_history TO anon, authenticated;

DROP POLICY IF EXISTS claims_select_involved ON public.claims;
DROP POLICY IF EXISTS claims_select_claimant_or_admin ON public.claims;
CREATE POLICY claims_select_claimant_or_admin ON public.claims
  FOR SELECT TO authenticated
  USING (claimant_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS claims_insert_own ON public.claims;
CREATE POLICY claims_insert_own ON public.claims
  FOR INSERT TO authenticated
  WITH CHECK (
    claimant_id = auth.uid()
    AND NOT public.is_admin()
    AND status = 'pending'
    AND admin_notes IS NULL
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND char_length(trim(lost_location_answer)) BETWEEN 3 AND 500
    AND EXISTS (
      SELECT 1 FROM public.items i
      WHERE i.id = claims.item_id
        AND i.type = 'found'
        AND i.reported_by <> auth.uid()
        AND i.status IN ('active', 'matched', 'claimed')
        AND i.verification_status <> 'rejected'
    )
  );

DROP POLICY IF EXISTS claims_update_claimant_or_admin ON public.claims;
DROP POLICY IF EXISTS claims_delete_admin ON public.claims;
REVOKE INSERT, UPDATE, DELETE ON public.claims FROM anon;
REVOKE UPDATE, DELETE ON public.claims FROM authenticated;
GRANT SELECT, INSERT ON public.claims TO authenticated;

-- All item creation now goes through create_item_report, which atomically
-- stores the public report and the private exact found location.
DROP POLICY IF EXISTS items_insert_own ON public.items;
REVOKE INSERT ON public.items FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Indexed, case-insensitive, partial search over public item fields only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_public_items(
  p_search text DEFAULT NULL,
  p_type public.item_type DEFAULT NULL,
  p_category public.item_category DEFAULT NULL,
  p_location text DEFAULT NULL,
  p_status public.item_status DEFAULT NULL,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 9,
  p_hide_rejected boolean DEFAULT true,
  p_sort text DEFAULT 'newest'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_search text := left(regexp_replace(lower(trim(coalesce(p_search, ''))), '[[:space:]]+', ' ', 'g'), 100);
  v_location text := lower(trim(coalesce(p_location, '')));
  v_page integer := greatest(1, coalesce(p_page, 1));
  v_page_size integer := least(48, greatest(1, coalesce(p_page_size, 9)));
  v_sort text := lower(coalesce(p_sort, 'newest'));
  v_result jsonb;
BEGIN
  v_search := replace(replace(v_search, '%', ''), '_', '');
  v_location := replace(replace(v_location, '%', ''), '_', '');

  IF p_date_from IS NOT NULL AND p_date_to IS NOT NULL AND p_date_from > p_date_to THEN
    RAISE EXCEPTION 'The start date must be on or before the end date.'
      USING errcode = '22007';
  END IF;
  IF v_sort NOT IN ('newest', 'oldest', 'relevance') THEN
    RAISE EXCEPTION 'Unsupported search sort order.' USING errcode = '22023';
  END IF;

  WITH filtered AS MATERIALIZED (
    SELECT i.*,
      CASE
        WHEN v_search = '' THEN 0::real
        ELSE ts_rank_cd(i.search_vector, websearch_to_tsquery('english', v_search))
      END AS relevance
    FROM public.items i
    WHERE (p_type IS NULL OR i.type = p_type)
      AND (p_category IS NULL OR i.category = p_category)
      AND (p_status IS NULL OR i.status = p_status)
      AND (NOT coalesce(p_hide_rejected, true) OR i.status <> 'rejected')
      AND (p_date_from IS NULL OR i.date_occurred >= p_date_from)
      AND (p_date_to IS NULL OR i.date_occurred <= p_date_to)
      AND (
        v_location = ''
        OR lower(i.location) LIKE '%' || v_location || '%'
      )
      AND (
        v_search = ''
        OR i.search_vector @@ websearch_to_tsquery('english', v_search)
        OR NOT EXISTS (
          SELECT 1
          FROM regexp_split_to_table(v_search, '[[:space:]]+') AS search_token(token)
          WHERE token <> ''
            AND NOT (
              lower(i.title) LIKE '%' || search_token.token || '%'
              OR lower(i.description) LIKE '%' || search_token.token || '%'
              OR lower(i.keywords) LIKE '%' || search_token.token || '%'
              OR lower(i.identifying_characteristics) LIKE '%' || search_token.token || '%'
              OR lower(i.location) LIKE '%' || search_token.token || '%'
              OR lower(i.category::text) LIKE '%' || search_token.token || '%'
            )
        )
      )
  ), page_rows AS (
    SELECT f.*,
      row_number() OVER (
        ORDER BY
          CASE WHEN v_sort = 'oldest' THEN f.created_at END ASC,
          CASE WHEN v_sort = 'newest' THEN f.created_at END DESC,
          CASE WHEN v_sort = 'relevance' THEN f.relevance END DESC,
          f.created_at DESC
      ) AS page_position
    FROM filtered f
    ORDER BY
      CASE WHEN v_sort = 'oldest' THEN f.created_at END ASC,
      CASE WHEN v_sort = 'newest' THEN f.created_at END DESC,
      CASE WHEN v_sort = 'relevance' THEN f.relevance END DESC,
      f.created_at DESC
    LIMIT v_page_size
    OFFSET (v_page - 1) * v_page_size
  ), page_json AS (
    SELECT coalesce(
      jsonb_agg(
        to_jsonb(pr) - 'search_vector' - 'relevance' - 'page_position'
        ORDER BY pr.page_position
      ),
      '[]'::jsonb
    ) AS rows
    FROM page_rows pr
  )
  SELECT jsonb_build_object(
    'rows', page_json.rows,
    'total', (SELECT count(*) FROM filtered),
    'page', v_page,
    'pageSize', v_page_size,
    'totalPages', greatest(1, ceil((SELECT count(*) FROM filtered)::numeric / v_page_size)::integer)
  )
  INTO v_result
  FROM page_json;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.search_public_items(
  text, public.item_type, public.item_category, text, public.item_status,
  date, date, integer, integer, boolean, text
) IS 'Searches public item fields only; exact finder locations and claim verification answers are stored elsewhere.';

REVOKE ALL ON FUNCTION public.search_public_items(
  text, public.item_type, public.item_category, text, public.item_status,
  date, date, integer, integer, boolean, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_public_items(
  text, public.item_type, public.item_category, text, public.item_status,
  date, date, integer, integer, boolean, text
) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Atomic item create: trusted caller identity + private exact location
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_item_report(
  p_type public.item_type,
  p_title text,
  p_category public.item_category,
  p_description text,
  p_location text,
  p_date_occurred date,
  p_keywords text DEFAULT '',
  p_identifying_characteristics text DEFAULT '',
  p_collection_instructions text DEFAULT NULL,
  p_exact_found_location text DEFAULT NULL,
  p_image_url text DEFAULT NULL,
  p_image_path text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_item public.items;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = v_uid) THEN
    RAISE EXCEPTION 'Sign in with a campus account before reporting an item.'
      USING errcode = '42501';
  END IF;
  IF char_length(trim(coalesce(p_title, ''))) NOT BETWEEN 3 AND 120 THEN
    RAISE EXCEPTION 'The item name must contain 3–120 characters.' USING errcode = '22023';
  END IF;
  IF char_length(trim(coalesce(p_description, ''))) NOT BETWEEN 10 AND 2000 THEN
    RAISE EXCEPTION 'The description must contain 10–2000 characters.' USING errcode = '22023';
  END IF;
  IF char_length(trim(coalesce(p_location, ''))) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'A general campus location of 2–120 characters is required.' USING errcode = '22023';
  END IF;
  IF p_date_occurred IS NULL OR p_date_occurred > current_date THEN
    RAISE EXCEPTION 'The report date must be today or earlier.' USING errcode = '22007';
  END IF;
  IF char_length(coalesce(p_keywords, '')) > 250 THEN
    RAISE EXCEPTION 'Keywords must be no longer than 250 characters.' USING errcode = '22023';
  END IF;
  IF char_length(coalesce(p_identifying_characteristics, '')) > 500 THEN
    RAISE EXCEPTION 'Identifying characteristics must be no longer than 500 characters.' USING errcode = '22023';
  END IF;

  IF p_type = 'found' THEN
    IF char_length(trim(coalesce(p_collection_instructions, ''))) NOT BETWEEN 10 AND 500 THEN
      RAISE EXCEPTION 'Found reports need collection instructions (10–500 characters).'
        USING errcode = '22023';
    END IF;
    IF char_length(trim(coalesce(p_exact_found_location, ''))) NOT BETWEEN 3 AND 300 THEN
      RAISE EXCEPTION 'Enter the exact discovery location for private ownership verification.'
        USING errcode = '22023';
    END IF;
  ELSE
    IF p_collection_instructions IS NOT NULL OR p_exact_found_location IS NOT NULL THEN
      RAISE EXCEPTION 'Collection instructions and exact found location only apply to found reports.'
        USING errcode = '22023';
    END IF;
  END IF;

  INSERT INTO public.items (
    reported_by, type, title, category, description, location, date_occurred,
    keywords, identifying_characteristics, collection_instructions,
    image_url, image_path, status, verification_status
  ) VALUES (
    v_uid, p_type, trim(p_title), p_category, trim(p_description), trim(p_location), p_date_occurred,
    trim(coalesce(p_keywords, '')), trim(coalesce(p_identifying_characteristics, '')),
    nullif(trim(coalesce(p_collection_instructions, '')), ''),
    p_image_url, p_image_path, 'active', 'pending'
  ) RETURNING * INTO v_item;

  IF p_type = 'found' THEN
    INSERT INTO public.item_private_details (item_id, exact_found_location)
    VALUES (v_item.id, trim(p_exact_found_location));
  END IF;

  RETURN to_jsonb(v_item) - 'search_vector';
END;
$$;

REVOKE ALL ON FUNCTION public.create_item_report(
  public.item_type, text, public.item_category, text, text, date,
  text, text, text, text, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_item_report(
  public.item_type, text, public.item_category, text, text, date,
  text, text, text, text, text, text
) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. Claims: secure review, private evidence, and separate handover
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.on_claim_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item public.items;
  v_admin record;
  v_name text;
BEGIN
  SELECT * INTO v_item FROM public.items WHERE id = new.item_id;
  IF NOT FOUND OR v_item.type <> 'found' THEN
    RAISE EXCEPTION 'Claims may only be submitted for found items.' USING errcode = '23514';
  END IF;

  SELECT full_name INTO v_name FROM public.profiles WHERE user_id = new.claimant_id;
  FOR v_admin IN SELECT user_id FROM public.profiles WHERE role = 'admin' LOOP
    PERFORM public.create_notification(
      v_admin.user_id, 'New claim awaiting review',
      coalesce(v_name, 'A campus member') || ' submitted a claim for "' || v_item.title || '".',
      'claim_submitted', v_item.id, new.id
    );
  END LOOP;

  PERFORM public.create_notification(
    new.claimant_id, 'Claim submitted',
    'Your claim for "' || v_item.title || '" is pending administrator review.',
    'claim_submitted', v_item.id, new.id
  );
  PERFORM public.create_notification(
    v_item.reported_by, 'Claim received on your found item',
    'A campus member submitted a claim for "' || v_item.title || '". An administrator will review it; private claimant evidence is not included here.',
    'claim_submitted', v_item.id, new.id
  );

  IF v_item.status IN ('active', 'matched') THEN
    PERFORM set_config('app.internal_write', 'on', true);
    UPDATE public.items SET status = 'claimed' WHERE id = v_item.id;
    PERFORM set_config('app.internal_write', 'off', true);
  END IF;

  PERFORM public.write_activity_log(new.claimant_id, 'claim_created', 'claim', new.id,
    jsonb_build_object('item_id', new.item_id, 'title', v_item.title));
  RETURN new;
END;
$$;

CREATE OR REPLACE FUNCTION public.on_claim_reviewed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item public.items;
BEGIN
  IF new.status IS NOT DISTINCT FROM old.status THEN
    RETURN new;
  END IF;

  SELECT * INTO v_item FROM public.items WHERE id = new.item_id;
  IF NOT FOUND THEN
    RETURN new;
  END IF;

  IF new.status IN ('approved', 'rejected', 'needs_info') AND new.reviewed_by IS NOT NULL THEN
    INSERT INTO public.claim_review_history
      (claim_id, item_id, reviewed_by, from_status, to_status, notes, created_at)
    VALUES
      (new.id, new.item_id, new.reviewed_by, old.status, new.status,
       new.admin_notes, coalesce(new.reviewed_at, now()));
  END IF;

  IF new.status = 'approved' THEN
    PERFORM public.create_notification(
      new.claimant_id, 'Claim approved',
      'Your claim for "' || v_item.title || '" was approved. The finder must confirm the physical handover; follow the public collection instructions.',
      'claim_approved', v_item.id, new.id
    );
    PERFORM public.create_notification(
      v_item.reported_by, 'Ownership claim approved',
      'An administrator approved a claim for "' || v_item.title || '". After physically handing it to the approved claimant, confirm handover on the item page.',
      'claim_approved', v_item.id, new.id
    );

    -- Approval means verified ownership; it does not mean the item has been
    -- physically handed over. Keep it in the claimed state until the finder
    -- confirms the handover through confirm_item_handover().
    PERFORM set_config('app.internal_write', 'on', true);
    UPDATE public.items
       SET status = 'claimed', resolved_at = NULL,
           handed_over_at = NULL, handed_over_by = NULL
     WHERE id = v_item.id;

    -- One verified owner wins. Other open claims are kept in the audit trail,
    -- rejected atomically and their claimants are notified by this trigger.
    UPDATE public.claims
       SET status = 'rejected',
           admin_notes = 'Another claim was approved for this item.',
           reviewed_by = new.reviewed_by,
           reviewed_at = now()
     WHERE item_id = v_item.id
       AND id <> new.id
       AND status IN ('pending', 'needs_info');
    PERFORM set_config('app.internal_write', 'off', true);

  ELSIF new.status = 'needs_info' THEN
    PERFORM public.create_notification(
      new.claimant_id, 'More information needed for your claim',
      'An administrator needs more information for your claim on "' || v_item.title || '". Open your claim to see the private note and respond.',
      'claim_needs_info', v_item.id, new.id
    );

  ELSIF new.status = 'rejected' THEN
    PERFORM public.create_notification(
      new.claimant_id, 'Claim rejected',
      'Your claim for "' || v_item.title || '" was rejected. Open your claim to view the private review note or contact an administrator.',
      'claim_rejected', v_item.id, new.id
    );

    IF NOT EXISTS (
      SELECT 1 FROM public.claims c
      WHERE c.item_id = new.item_id AND c.id <> new.id
        AND c.status IN ('pending', 'needs_info', 'approved')
    ) AND v_item.status = 'claimed' THEN
      PERFORM set_config('app.internal_write', 'on', true);
      UPDATE public.items SET status = 'active', resolved_at = NULL WHERE id = v_item.id;
      PERFORM set_config('app.internal_write', 'off', true);
    END IF;

  ELSIF new.status = 'cancelled' THEN
    PERFORM public.create_notification(
      v_item.reported_by, 'Claim withdrawn',
      'A claim on "' || v_item.title || '" was withdrawn by the claimant.',
      'claim_cancelled', v_item.id, new.id
    );

    IF NOT EXISTS (
      SELECT 1 FROM public.claims c
      WHERE c.item_id = new.item_id AND c.id <> new.id
        AND c.status IN ('pending', 'needs_info', 'approved')
    ) AND v_item.status = 'claimed' THEN
      PERFORM set_config('app.internal_write', 'on', true);
      UPDATE public.items SET status = 'active', resolved_at = NULL WHERE id = v_item.id;
      PERFORM set_config('app.internal_write', 'off', true);
    END IF;
  END IF;

  PERFORM public.write_activity_log(
    coalesce(auth.uid(), new.reviewed_by, new.claimant_id),
    'claim_' || new.status::text,
    'claim', new.id,
    jsonb_build_object('item_id', new.item_id, 'title', v_item.title)
  );
  RETURN new;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_claim_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF public.internal_write() THEN
    RETURN new;
  END IF;
  RAISE EXCEPTION 'Claim status and evidence may only be changed through the authorized claim workflow.'
    USING errcode = '42501';
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_claim ON public.claims;
CREATE TRIGGER trg_guard_claim
  BEFORE UPDATE ON public.claims
  FOR EACH ROW EXECUTE FUNCTION public.guard_claim_update();

CREATE OR REPLACE FUNCTION public.review_claim(
  p_claim_id uuid,
  p_decision public.claim_status,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_item_id uuid;
  v_item public.items;
  v_claim public.claims;
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
BEGIN
  IF v_uid IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'Administrator access required.' USING errcode = '42501';
  END IF;
  IF p_decision NOT IN ('approved', 'rejected', 'needs_info') THEN
    RAISE EXCEPTION 'Choose approved, rejected or needs_info.' USING errcode = '22023';
  END IF;
  IF char_length(coalesce(v_notes, '')) > 500 THEN
    RAISE EXCEPTION 'Administrator notes must be no longer than 500 characters.' USING errcode = '22023';
  END IF;
  IF p_decision = 'needs_info' AND char_length(coalesce(v_notes, '')) < 5 THEN
    RAISE EXCEPTION 'Add a clear note describing what information is needed.' USING errcode = '22023';
  END IF;

  SELECT item_id INTO v_item_id FROM public.claims WHERE id = p_claim_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim not found.' USING errcode = 'P0002';
  END IF;

  -- Lock the item first in every review/handover path, then re-read the claim.
  -- This serializes competing approvals for the same found item.
  SELECT * INTO v_item FROM public.items WHERE id = v_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The item for this claim no longer exists.' USING errcode = 'P0002';
  END IF;
  SELECT * INTO v_claim FROM public.claims WHERE id = p_claim_id FOR UPDATE;
  IF NOT FOUND OR v_claim.item_id <> v_item_id THEN
    RAISE EXCEPTION 'Claim not found.' USING errcode = 'P0002';
  END IF;
  IF v_claim.status <> 'pending' THEN
    RAISE EXCEPTION 'This claim is no longer pending review.' USING errcode = '55000';
  END IF;
  IF v_item.type <> 'found' OR v_item.status IN ('returned', 'closed', 'rejected')
     OR v_item.verification_status = 'rejected' THEN
    RAISE EXCEPTION 'This item is no longer eligible for claim review.' USING errcode = '55000';
  END IF;
  IF p_decision = 'approved' AND EXISTS (
    SELECT 1 FROM public.claims c
    WHERE c.item_id = v_item_id AND c.status = 'approved' AND c.id <> p_claim_id
  ) THEN
    RAISE EXCEPTION 'Another claim has already been approved for this item.' USING errcode = '23505';
  END IF;

  PERFORM set_config('app.internal_write', 'on', true);
  UPDATE public.claims
     SET status = p_decision,
         admin_notes = v_notes,
         reviewed_by = v_uid,
         reviewed_at = now()
   WHERE id = p_claim_id;
  PERFORM set_config('app.internal_write', 'off', true);

  RETURN jsonb_build_object('ok', true, 'claim_id', p_claim_id, 'status', p_decision);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_claim(p_claim_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_item_id uuid;
  v_claim public.claims;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Please sign in to continue.' USING errcode = '42501';
  END IF;
  SELECT item_id INTO v_item_id FROM public.claims
   WHERE id = p_claim_id AND claimant_id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim not found.' USING errcode = 'P0002';
  END IF;
  PERFORM 1 FROM public.items WHERE id = v_item_id FOR UPDATE;
  SELECT * INTO v_claim FROM public.claims WHERE id = p_claim_id FOR UPDATE;
  IF v_claim.status NOT IN ('pending', 'needs_info') THEN
    RAISE EXCEPTION 'Only a pending or information-requested claim can be withdrawn.'
      USING errcode = '55000';
  END IF;

  PERFORM set_config('app.internal_write', 'on', true);
  UPDATE public.claims
  SET status = 'cancelled', reviewed_by = NULL, reviewed_at = NULL
  WHERE id = p_claim_id;
  PERFORM set_config('app.internal_write', 'off', true);
  RETURN jsonb_build_object('ok', true, 'claim_id', p_claim_id, 'status', 'cancelled');
END;
$$;

CREATE OR REPLACE FUNCTION public.respond_to_claim_request(
  p_claim_id uuid,
  p_message text,
  p_lost_location_answer text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_item_id uuid;
  v_claim public.claims;
  v_admin record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Please sign in to continue.' USING errcode = '42501';
  END IF;
  IF char_length(trim(coalesce(p_message, ''))) NOT BETWEEN 15 AND 1000 THEN
    RAISE EXCEPTION 'Claim explanation must contain 15–1000 characters.' USING errcode = '22023';
  END IF;
  IF char_length(trim(coalesce(p_lost_location_answer, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'Your believed lost location must contain 3–500 characters.' USING errcode = '22023';
  END IF;

  SELECT item_id INTO v_item_id FROM public.claims
   WHERE id = p_claim_id AND claimant_id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim not found.' USING errcode = 'P0002';
  END IF;
  PERFORM 1 FROM public.items WHERE id = v_item_id FOR UPDATE;
  SELECT * INTO v_claim FROM public.claims WHERE id = p_claim_id FOR UPDATE;
  IF v_claim.status <> 'needs_info' THEN
    RAISE EXCEPTION 'This claim is not waiting for more information.' USING errcode = '55000';
  END IF;

  PERFORM set_config('app.internal_write', 'on', true);
  UPDATE public.claims
     SET message = trim(p_message),
         lost_location_answer = trim(p_lost_location_answer),
         status = 'pending',
         reviewed_by = NULL,
         reviewed_at = NULL
   WHERE id = p_claim_id;
  PERFORM set_config('app.internal_write', 'off', true);

  FOR v_admin IN SELECT user_id FROM public.profiles WHERE role = 'admin' LOOP
    PERFORM public.create_notification(
      v_admin.user_id, 'Claimant sent more information',
      'A claimant sent more information for item "' ||
        (SELECT title FROM public.items WHERE id = v_item_id) || '".',
      'claim_submitted', v_item_id, p_claim_id
    );
  END LOOP;
  PERFORM public.write_activity_log(v_uid, 'claim_response_submitted', 'claim', p_claim_id,
    jsonb_build_object('item_id', v_item_id));

  RETURN jsonb_build_object('ok', true, 'claim_id', p_claim_id, 'status', 'pending');
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Physical handover is a separate, finder-confirmed database transaction
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_item_handover(p_item_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_item public.items;
  v_claimant_id uuid;
  v_claim_count integer;
  v_handover_time timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Please sign in to confirm a handover.' USING errcode = '42501';
  END IF;

  SELECT * INTO v_item FROM public.items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item not found.' USING errcode = 'P0002';
  END IF;
  IF v_item.type <> 'found' OR v_item.reported_by <> v_uid THEN
    RAISE EXCEPTION 'Only the finder who reported this found item may confirm its handover.'
      USING errcode = '42501';
  END IF;
  IF v_item.status = 'returned' OR v_item.handed_over_at IS NOT NULL THEN
    RAISE EXCEPTION 'This item has already been handed over.' USING errcode = '55000';
  END IF;
  IF v_item.status <> 'claimed' THEN
    RAISE EXCEPTION 'The item must have an approved claim before handover.' USING errcode = '55000';
  END IF;

  SELECT count(*), min(claimant_id)
    INTO v_claim_count, v_claimant_id
  FROM public.claims
  WHERE item_id = p_item_id AND status = 'approved';
  IF v_claim_count <> 1 OR v_claimant_id IS NULL THEN
    RAISE EXCEPTION 'Exactly one approved claim is required before handover.' USING errcode = '55000';
  END IF;

  PERFORM set_config('app.internal_write', 'on', true);
  UPDATE public.items
     SET status = 'returned',
         resolved_at = v_handover_time,
         handed_over_at = v_handover_time,
         handed_over_by = v_uid
   WHERE id = p_item_id;
  PERFORM public.create_notification(
    v_claimant_id, 'Item handover confirmed',
    'The finder confirmed that "' || v_item.title || '" was physically handed over to you.',
    'item_handed_over', p_item_id, NULL
  );
  PERFORM public.write_activity_log(
    v_uid, 'item_handed_over', 'item', p_item_id,
    jsonb_build_object('claimant_id', v_claimant_id, 'handed_over_at', v_handover_time)
  );
  PERFORM set_config('app.internal_write', 'off', true);

  RETURN jsonb_build_object(
    'ok', true,
    'item_id', p_item_id,
    'status', 'returned',
    'handed_over_at', v_handover_time,
    'handed_over_by', v_uid
  );
END;
$$;

-- An administrator cannot bypass the handover step by directly setting the
-- item status or handover columns. The SECURITY DEFINER transaction above is
-- the only supported route to `returned`.
CREATE OR REPLACE FUNCTION public.guard_item_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF new.reported_by IS DISTINCT FROM old.reported_by THEN
    RAISE EXCEPTION 'A report cannot be re-assigned to another user.' USING errcode = '42501';
  END IF;
  IF new.type IS DISTINCT FROM old.type THEN
    RAISE EXCEPTION 'The lost/found type cannot be changed after reporting.' USING errcode = '42501';
  END IF;
  IF (new.handed_over_at IS DISTINCT FROM old.handed_over_at
      OR new.handed_over_by IS DISTINCT FROM old.handed_over_by)
     AND NOT public.internal_write() THEN
    RAISE EXCEPTION 'Handover fields may only be changed by the handover operation.' USING errcode = '42501';
  END IF;
  IF new.status = 'returned' AND old.status IS DISTINCT FROM new.status
     AND NOT public.internal_write() THEN
    RAISE EXCEPTION 'Use the finder-confirmed handover operation to mark an item returned.'
      USING errcode = '42501';
  END IF;
  IF old.status = 'returned' AND new.status IS DISTINCT FROM old.status
     AND NOT public.internal_write() THEN
    RAISE EXCEPTION 'A completed handover cannot be reversed from the item editor.'
      USING errcode = '42501';
  END IF;

  IF public.internal_write() OR public.is_admin() THEN
    RETURN new;
  END IF;

  IF new.status IS DISTINCT FROM old.status
     AND new.status NOT IN ('closed', 'active') THEN
    RAISE EXCEPTION 'Only an administrator can set the status "%".', new.status
      USING errcode = '42501';
  END IF;
  IF new.verification_status IS DISTINCT FROM old.verification_status THEN
    RAISE EXCEPTION 'Verification status can only be changed by an administrator.'
      USING errcode = '42501';
  END IF;
  RETURN new;
END;
$$;

REVOKE ALL ON FUNCTION public.review_claim(uuid, public.claim_status, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_claim(uuid, public.claim_status, text) TO authenticated;
REVOKE ALL ON FUNCTION public.cancel_claim(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_claim(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.respond_to_claim_request(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_to_claim_request(uuid, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.confirm_item_handover(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_item_handover(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 9. Safe persistent notifications; a match links to the OTHER report
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.on_match_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lost public.items;
  v_found public.items;
BEGIN
  SELECT * INTO v_lost FROM public.items WHERE id = new.lost_item_id;
  SELECT * INTO v_found FROM public.items WHERE id = new.found_item_id;

  IF new.score >= 60 THEN
    IF v_lost.reported_by = v_found.reported_by THEN
      PERFORM public.create_notification(
        v_lost.reported_by, 'Possible match found',
        'Your lost report "' || v_lost.title || '" may match the found report "' || v_found.title || '". Similarity is a lead, not proof of ownership.',
        'match', v_found.id, NULL
      );
    ELSE
      PERFORM public.create_notification(
        v_lost.reported_by, 'Possible found-item match',
        'Your lost report "' || v_lost.title || '" may match found report "' || v_found.title || '". Similarity is a lead, not proof of ownership.',
        'match', v_found.id, NULL
      );
      PERFORM public.create_notification(
        v_found.reported_by, 'Possible owner match',
        'Your found report "' || v_found.title || '" may match lost report "' || v_lost.title || '". Similarity is a lead, not proof of ownership.',
        'match', v_lost.id, NULL
      );
    END IF;
  END IF;

  PERFORM public.write_activity_log(v_lost.reported_by, 'match_created', 'match', new.id,
    jsonb_build_object('lost_item_id', new.lost_item_id,
      'found_item_id', new.found_item_id, 'score', new.score));
  RETURN new;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_verification_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF new.verification_status IS DISTINCT FROM old.verification_status THEN
    IF new.verification_status = 'verified' THEN
      PERFORM public.create_notification(new.reported_by,
        'Report verified',
        'Your report "' || new.title || '" has been verified by an administrator.',
        'report_verified', new.id, NULL);
    ELSIF new.verification_status = 'rejected' THEN
      PERFORM public.create_notification(new.reported_by,
        'Report rejected',
        'Your report "' || new.title || '" was rejected. Please review the campus lost-and-found guidelines.',
        'report_rejected', new.id, NULL);
    END IF;
  END IF;

  IF new.status = 'rejected' AND old.status <> 'rejected' THEN
    PERFORM public.create_notification(new.reported_by,
      'Report removed',
      'Your report "' || new.title || '" has been removed by an administrator.',
      'item_status', new.id, NULL);
  END IF;

  IF new.status = 'returned' AND old.status <> 'returned' THEN
    PERFORM public.create_notification(new.reported_by,
      'Handover confirmed',
      'You confirmed the physical handover of "' || new.title || '". The item is now recorded as returned.',
      'item_handed_over', new.id, NULL);
  END IF;
  RETURN new;
END;
$$;

-- Fix the earlier email-domain helper's mismatched write_activity_log call.
CREATE OR REPLACE FUNCTION public.set_allowed_email_domain(p_domain text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_domain text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only an administrator may change the college e-mail rule.'
      USING errcode = '42501';
  END IF;
  v_domain := lower(trim(coalesce(p_domain, '')));
  v_domain := ltrim(v_domain, '@');
  IF v_domain <> '' AND position('.' IN v_domain) = 0 THEN
    RAISE EXCEPTION 'A domain needs at least one dot, e.g. campus.example (or empty to accept any).'
      USING errcode = 'check_violation';
  END IF;
  UPDATE public.app_settings SET allowed_email_domain = v_domain WHERE id = 1;
  PERFORM public.write_activity_log(
    auth.uid(), 'email_domain_changed', 'app_settings', NULL,
    jsonb_build_object('allowed_email_domain', v_domain)
  );
  RETURN v_domain;
END;
$$;

REVOKE ALL ON FUNCTION public.set_allowed_email_domain(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_allowed_email_domain(text) TO authenticated;

-- Update aggregate counters without exposing profile details.
CREATE OR REPLACE FUNCTION public.public_stats()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'active_lost_items', (SELECT count(*) FROM public.items
      WHERE type = 'lost' AND status NOT IN ('rejected', 'returned', 'closed')),
    'found_items', (SELECT count(*) FROM public.items
      WHERE type = 'found' AND status NOT IN ('rejected', 'returned', 'closed')),
    'possible_matches', (SELECT count(*) FROM public.matches WHERE status = 'suggested'),
    'recovered_items', (SELECT count(*) FROM public.items WHERE status = 'returned'),
    'total_items', (SELECT count(*) FROM public.items WHERE status <> 'rejected'),
    'registered_students', (SELECT count(*) FROM public.profiles WHERE role = 'student'),
    'registered_campus_users', (SELECT count(*) FROM public.profiles WHERE role IN ('student', 'faculty', 'staff'))
  );
$$;

CREATE OR REPLACE FUNCTION public.admin_stats()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Administrator access required.' USING errcode = '42501';
  END IF;
  RETURN jsonb_build_object(
    'total_students', (SELECT count(*) FROM public.profiles WHERE role = 'student'),
    'total_faculty', (SELECT count(*) FROM public.profiles WHERE role = 'faculty'),
    'total_staff', (SELECT count(*) FROM public.profiles WHERE role = 'staff'),
    'total_campus_users', (SELECT count(*) FROM public.profiles WHERE role IN ('student', 'faculty', 'staff')),
    'total_admins', (SELECT count(*) FROM public.profiles WHERE role = 'admin'),
    'total_items', (SELECT count(*) FROM public.items WHERE status <> 'rejected'),
    'total_lost', (SELECT count(*) FROM public.items WHERE type = 'lost' AND status <> 'rejected'),
    'total_found', (SELECT count(*) FROM public.items WHERE type = 'found' AND status <> 'rejected'),
    'pending_verification', (SELECT count(*) FROM public.items WHERE verification_status = 'pending' AND status <> 'rejected'),
    'verified_items', (SELECT count(*) FROM public.items WHERE verification_status = 'verified'),
    'pending_claims', (SELECT count(*) FROM public.claims WHERE status = 'pending'),
    'total_claims', (SELECT count(*) FROM public.claims),
    'approved_claims', (SELECT count(*) FROM public.claims WHERE status = 'approved'),
    'rejected_claims', (SELECT count(*) FROM public.claims WHERE status = 'rejected'),
    'possible_matches', (SELECT count(*) FROM public.matches),
    'strong_matches', (SELECT count(*) FROM public.matches WHERE score >= 75),
    'recovered_items', (SELECT count(*) FROM public.items WHERE status = 'returned'),
    'open_abuse_reports', (SELECT count(*) FROM public.reports WHERE status = 'pending'),
    'recovery_rate', coalesce((
      SELECT round(100.0 * count(*) FILTER (WHERE status = 'returned') /
        nullif(count(*) FILTER (WHERE status <> 'rejected'), 0))
      FROM public.items
    ), 0)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 10. Audit/data access grants and final function permissions
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.item_private_details FROM anon;
REVOKE ALL ON public.claim_review_history FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.item_private_details FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.claim_review_history FROM anon, authenticated;
GRANT SELECT ON public.item_private_details, public.claim_review_history TO authenticated;

REVOKE ALL ON FUNCTION public.public_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_stats() TO anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_stats() TO authenticated;

-- Safe re-application of policies after the original, broader project policy.
DROP POLICY IF EXISTS item_private_details_select_finder_or_admin ON public.item_private_details;
CREATE POLICY item_private_details_select_finder_or_admin ON public.item_private_details
  FOR SELECT TO authenticated
  USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.items i
      WHERE i.id = item_private_details.item_id AND i.reported_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS claim_review_history_select_admin ON public.claim_review_history;
CREATE POLICY claim_review_history_select_admin ON public.claim_review_history
  FOR SELECT TO authenticated USING (public.is_admin());

-- End of additive migration.
