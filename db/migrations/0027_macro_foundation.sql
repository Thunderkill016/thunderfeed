BEGIN;

-- 0027: Macro Indicator Foundation V1.
--
--   provider series code ──► macro_series ──► macro_points (obs_date)
--        │                                     │
--        │                        macro_point_versions (append-only,
--        ▼                                     │  vintage_date-keyed)
--   reference_observations ◄── observation_id ─┘
--
--   Macro data is REVISED — "US CPI for March as known in April" and
--   "the same month as known in July" are different facts. Versioning is
--   keyed on vintage_date (ALFRED realtime date): each provider-reported
--   revision appends version_no+1; history is never rewritten.
--
--   Identity is the provider series code (FRED series id), never a
--   display name — display titles change, codes don't.

CREATE TABLE macro_series (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  canonical_key       text NOT NULL UNIQUE,  -- 'macro_series:fred:CPIAUCSL'
  provider            text NOT NULL,
  series_code         text NOT NULL,         -- provider's stable id
  title               text,
  frequency           text,                  -- provider's freq code (d/w/m/q/a)
  units               text,
  seasonal_adjustment text,
  entity_id           uuid REFERENCES entities(id),  -- scope: country/CB/etc
  status              text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','inactive')),
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, series_code)
);
CREATE INDEX idx_macro_series_entity ON macro_series (entity_id);

-- One observation period per series. obs_date is DATE — a period stamp,
-- not a UTC instant.
CREATE TABLE macro_points (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  series_id          uuid NOT NULL REFERENCES macro_series(id),
  obs_date           date NOT NULL,
  current_version_id uuid,             -- mutable pointer, like market_points
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (series_id, obs_date)
);
CREATE INDEX idx_macro_points_series_date
  ON macro_points (series_id, obs_date DESC);

-- Append-only indicator values. vintage_date = the ALFRED realtime date
-- the value was current as-of; a revision is a new version, never an
-- UPDATE. value is numeric — exact decimal, never float. Missing-provider
-- values ('.') produce NO version — unknown stays unknown.
CREATE TABLE macro_point_versions (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  point_id            uuid NOT NULL REFERENCES macro_points(id),
  version_no          integer NOT NULL,
  vintage_date        date NOT NULL,
  value               numeric NOT NULL,
  observation_id      uuid REFERENCES reference_observations(id),
  previous_version_id uuid,
  observed_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (point_id, version_no),
  -- composite target for both pointer FKs (0026 pattern): a pointer can
  -- never reference a version belonging to a different point
  UNIQUE (id, point_id)
);
CREATE INDEX idx_macro_point_versions_point
  ON macro_point_versions (point_id);
CREATE INDEX idx_macro_point_versions_obs
  ON macro_point_versions (observation_id);

ALTER TABLE macro_points
  ADD CONSTRAINT macro_points_current_version_fkey
  FOREIGN KEY (current_version_id, id)
  REFERENCES macro_point_versions (id, point_id);
ALTER TABLE macro_point_versions
  ADD CONSTRAINT macro_point_versions_previous_fkey
  FOREIGN KEY (previous_version_id, point_id)
  REFERENCES macro_point_versions (id, point_id);

-- == PG-ONLY: security posture + append-only invariants ====================

-- 'fred' joins the provider allowlist (prod constraint auto-named in 0020;
-- pg-mem names it differently — same PG-only treatment as 0023/0026).
ALTER TABLE reference_observations
  DROP CONSTRAINT reference_observations_provider_check;
ALTER TABLE reference_observations
  ADD CONSTRAINT reference_observations_provider_check CHECK (provider IN (
    'sec_edgar', 'iso_10383', 'openfigi', 'anna', 'manual_verified',
    'alphavantage', 'tiingo', 'fred', 'other'
  ));

ALTER TABLE macro_series           ENABLE ROW LEVEL SECURITY;
ALTER TABLE macro_points           ENABLE ROW LEVEL SECURITY;
ALTER TABLE macro_point_versions   ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  macro_series, macro_points, macro_point_versions
  FROM anon, authenticated;

CREATE TRIGGER trg_macro_point_versions_immutable
  BEFORE UPDATE OR DELETE ON macro_point_versions
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

COMMIT;
