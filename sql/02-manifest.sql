-- ============================================================================
-- LogLineOS Initial Manifest
-- ============================================================================
-- Run this AFTER sql/01-schema.sql
-- ============================================================================

INSERT INTO ledger.universal_registry (
  id,
  seq,
  entity_type,
  who,
  did,
  "this",
  at,
  status,
  name,
  owner_id,
  tenant_id,
  visibility,
  metadata
)
VALUES (
  '00000000-0000-4000-8000-0000000000aa',
  0,
  'manifest',
  'system',
  'defined',
  'manifest',
  now(),
  'active',
  'kernel_manifest_v1',
  'system',
  'system',
  'public',
  jsonb_build_object(
    'version', '1.0.0',
    'kernels', jsonb_build_object(
      'run_code',        '00000000-0000-4000-8000-000000000001',
      'observer',        '00000000-0000-4000-8000-000000000002',
      'request_worker',  '00000000-0000-4000-8000-000000000003',
      'policy_agent',    '00000000-0000-4000-8000-000000000004',
      'provider_exec',   '00000000-0000-4000-8000-000000000005'
    ),
    'allowed_boot_ids', jsonb_build_array(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000005'
    ),
    'throttle', jsonb_build_object(
      'per_tenant_daily_exec_limit', 1000,
      'per_user_daily_exec_limit', 100
    ),
    'policy', jsonb_build_object(
      'slow_ms', 5000,
      'timeout_ms', 30000,
      'circuit_breaker_threshold', 10
    ),
    'features', jsonb_build_object(
      'signatures_required', false,
      'strict_mode', false,
      'audit_log', true
    ),
    'override_pubkey_hex', '',
    'created_at', now(),
    'created_by', 'bootstrap'
  )
)
ON CONFLICT (id, seq) DO NOTHING;
