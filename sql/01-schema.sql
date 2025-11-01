-- ============================================================================
-- LogLineOS Core Schema
-- ============================================================================
-- This file creates the universal registry table, RLS policies, triggers,
-- and indexes following the Blueprint specification.
--
-- Run this in your Supabase SQL Editor FIRST.
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_cron";

-- Create schemas
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS ledger;

-- ============================================================================
-- Session Accessors for RLS
-- ============================================================================

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS text
LANGUAGE sql STABLE AS $$ 
  SELECT COALESCE(
    current_setting('app.user_id', true),
    NULLIF(current_setting('request.jwt.claims', true)::json->>'sub', '')::text
  )
$$;

CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS text
LANGUAGE sql STABLE AS $$ 
  SELECT COALESCE(
    current_setting('app.tenant_id', true),
    NULLIF(current_setting('request.jwt.claims', true)::json->>'tenant_id', '')::text
  )
$$;

-- ============================================================================
-- Universal Registry (Core Table - ~70 semantic columns)
-- ============================================================================

CREATE TABLE IF NOT EXISTS ledger.universal_registry (
  -- Primary keys
  id            uuid        NOT NULL,
  seq           integer     NOT NULL DEFAULT 0,
  
  -- Entity classification
  entity_type   text        NOT NULL,   -- function, execution, request, policy, provider, metric, etc.
  
  -- Who/What/When (semantic core)
  who           text        NOT NULL,   -- Actor (user, system, kernel)
  did           text,                   -- Action verb (executed, scheduled, etc.)
  "this"        text        NOT NULL,   -- Subject/resource
  at            timestamptz NOT NULL DEFAULT now(),
  
  -- Relationships
  parent_id     uuid,
  related_to    uuid[],
  
  -- Access control (RLS)
  owner_id      text,
  tenant_id     text,
  visibility    text        NOT NULL DEFAULT 'private', -- private|tenant|public
  
  -- Lifecycle
  status        text,       -- draft|scheduled|queued|running|complete|error|active|open|pass|fail|slow
  is_deleted    boolean     NOT NULL DEFAULT false,
  
  -- Naming & description
  name          text,
  description   text,
  
  -- Code & execution context
  code          text,
  language      text,
  runtime       text,
  
  -- I/O
  input         jsonb,
  output        jsonb,
  error         jsonb,
  
  -- Metrics
  duration_ms   integer,
  trace_id      text,
  
  -- Cryptographic proofs
  prev_hash     text,
  curr_hash     text,
  signature     text,
  public_key    text,
  
  -- Extensibility
  metadata      jsonb,
  
  -- Constraints
  PRIMARY KEY (id, seq),
  CONSTRAINT ck_visibility CHECK (visibility IN ('private','tenant','public')),
  CONSTRAINT ck_append_only CHECK (seq >= 0)
);

-- ============================================================================
-- Visible Timeline View (legacy "when" alias for "at")
-- ============================================================================

CREATE OR REPLACE VIEW ledger.visible_timeline AS
SELECT
  ur.*,
  ur.at AS "when"
FROM ledger.universal_registry ur
WHERE ur.is_deleted = false;

-- ============================================================================
-- Append-Only Enforcement (No UPDATE/DELETE allowed)
-- ============================================================================

CREATE OR REPLACE FUNCTION ledger.no_updates() RETURNS trigger 
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Append-only table: updates/deletes are not allowed';
END;
$$;

DROP TRIGGER IF EXISTS ur_no_update ON ledger.universal_registry;
CREATE TRIGGER ur_no_update 
  BEFORE UPDATE OR DELETE ON ledger.universal_registry
  FOR EACH ROW EXECUTE FUNCTION ledger.no_updates();

-- ============================================================================
-- NOTIFY on INSERT (for SSE/Real-time)
-- ============================================================================

CREATE OR REPLACE FUNCTION ledger.notify_timeline() RETURNS trigger 
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('timeline_updates', row_to_json(NEW)::text);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ur_notify_insert ON ledger.universal_registry;
CREATE TRIGGER ur_notify_insert 
  AFTER INSERT ON ledger.universal_registry
  FOR EACH ROW EXECUTE FUNCTION ledger.notify_timeline();

-- ============================================================================
-- Indexes (Performance)
-- ============================================================================

CREATE INDEX IF NOT EXISTS ur_idx_at ON ledger.universal_registry (at DESC);
CREATE INDEX IF NOT EXISTS ur_idx_entity ON ledger.universal_registry (entity_type, at DESC);
CREATE INDEX IF NOT EXISTS ur_idx_owner_tenant ON ledger.universal_registry (owner_id, tenant_id);
CREATE INDEX IF NOT EXISTS ur_idx_trace ON ledger.universal_registry (trace_id);
CREATE INDEX IF NOT EXISTS ur_idx_parent ON ledger.universal_registry (parent_id);
CREATE INDEX IF NOT EXISTS ur_idx_related ON ledger.universal_registry USING GIN (related_to);
CREATE INDEX IF NOT EXISTS ur_idx_metadata ON ledger.universal_registry USING GIN (metadata);
CREATE INDEX IF NOT EXISTS ur_idx_status ON ledger.universal_registry (entity_type, status, at DESC);

-- Idempotency index for observer-generated requests
CREATE UNIQUE INDEX IF NOT EXISTS ur_idx_request_idempotent
  ON ledger.universal_registry (parent_id, entity_type, status)
  WHERE entity_type = 'request' AND status = 'scheduled' AND is_deleted = false;

-- ============================================================================
-- Row Level Security (RLS) Policies
-- ============================================================================

ALTER TABLE ledger.universal_registry ENABLE ROW LEVEL SECURITY;

-- SELECT Policy: owner OR same tenant with visibility tenant/public OR visibility public
DROP POLICY IF EXISTS ur_select_policy ON ledger.universal_registry;
CREATE POLICY ur_select_policy ON ledger.universal_registry
  FOR SELECT USING (
    (owner_id IS NOT DISTINCT FROM app.current_user_id())
    OR (visibility = 'public')
    OR (tenant_id IS NOT DISTINCT FROM app.current_tenant_id() AND visibility IN ('tenant','public'))
  );

-- INSERT Policy: requester must set app.user_id; row owner_id = app.user_id; tenant matches session
DROP POLICY IF EXISTS ur_insert_policy ON ledger.universal_registry;
CREATE POLICY ur_insert_policy ON ledger.universal_registry
  FOR INSERT WITH CHECK (
    owner_id IS NOT DISTINCT FROM app.current_user_id()
    AND (tenant_id IS NULL OR tenant_id IS NOT DISTINCT FROM app.current_tenant_id())
  );

-- ============================================================================
-- Helper RPC for SQL execution (used by Supabase-JS wrapper)
-- ============================================================================

CREATE OR REPLACE FUNCTION exec_sql(
  query text,
  params jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result jsonb;
BEGIN
  -- This is a simplified version. 
  -- In production, you'd want to parse params and use EXECUTE with proper parameter binding.
  -- For now, this allows the hybrid approach from ADR-002.
  
  EXECUTE query INTO result;
  
  RETURN result;
END;
$$;

-- Grant access to authenticated and service_role
GRANT EXECUTE ON FUNCTION exec_sql TO authenticated, service_role;

-- ============================================================================
-- Verification Query
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE '✅ Schema created successfully';
  RAISE NOTICE '   - universal_registry table created';
  RAISE NOTICE '   - RLS policies enabled';
  RAISE NOTICE '   - Append-only trigger active';
  RAISE NOTICE '   - NOTIFY trigger active';
  RAISE NOTICE '   - Indexes created';
  RAISE NOTICE '';
  RAISE NOTICE 'Next steps:';
  RAISE NOTICE '   1. Run sql/02-manifest.sql';
  RAISE NOTICE '   2. npm run bootstrap:kernels';
END $$;
