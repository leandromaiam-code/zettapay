-- HR-* (Hard Rule) schema extension for fabric_layer0_premissas.
-- Apply on the Fabric control-plane Supabase database. Idempotent.
--
-- After applying, run fabric/seed/zettapay_hrs.sql to seed the 4 initial
-- Hard Rules for the zettapay workspace.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'fabric_layer0_premissas' AND column_name = 'severity'
  ) THEN
    ALTER TABLE public.fabric_layer0_premissas
      ADD COLUMN severity TEXT NOT NULL DEFAULT 'soft';
    ALTER TABLE public.fabric_layer0_premissas
      ADD CONSTRAINT fabric_layer0_premissas_severity_check
      CHECK (severity IN ('soft', 'hard', 'blocker'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'fabric_layer0_premissas' AND column_name = 'detection_patterns'
  ) THEN
    ALTER TABLE public.fabric_layer0_premissas
      ADD COLUMN detection_patterns JSONB NOT NULL DEFAULT '[]'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'fabric_layer0_premissas' AND column_name = 'premissa_kind'
  ) THEN
    ALTER TABLE public.fabric_layer0_premissas
      ADD COLUMN premissa_kind TEXT NOT NULL DEFAULT 'guidance';
    ALTER TABLE public.fabric_layer0_premissas
      ADD CONSTRAINT fabric_layer0_premissas_kind_check
      CHECK (premissa_kind IN ('guidance', 'HR'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS fabric_layer0_premissas_kind_workspace_idx
  ON public.fabric_layer0_premissas (workspace_id, premissa_kind);

COMMENT ON COLUMN public.fabric_layer0_premissas.severity IS
  'soft = guidance only; hard = blocks merge + preflight; blocker = blocks even with override';
COMMENT ON COLUMN public.fabric_layer0_premissas.detection_patterns IS
  'JSON array of regex strings used by hr-scan and pre-merge gates';
COMMENT ON COLUMN public.fabric_layer0_premissas.premissa_kind IS
  'guidance = informational Layer 0; HR = Hard Rule with detection + enforcement';
