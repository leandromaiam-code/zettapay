-- Add per-HR allowlist_paths column to fabric_layer0_premissas.
-- Apply on the Fabric control-plane Supabase database, before re-running
-- fabric/seed/zettapay_hrs.sql (which references the new column). Idempotent.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'fabric_layer0_premissas' AND column_name = 'allowlist_paths'
  ) THEN
    ALTER TABLE public.fabric_layer0_premissas
      ADD COLUMN allowlist_paths JSONB NOT NULL DEFAULT '[]'::jsonb;
  END IF;
END$$;

COMMENT ON COLUMN public.fabric_layer0_premissas.allowlist_paths IS
  'JSON array of glob path patterns where this HR is intentionally permitted (overlay on global PATH_ALLOWLIST). Use **/ for any-depth, * for single segment.';
