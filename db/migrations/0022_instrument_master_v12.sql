BEGIN;

-- 0022: Instrument Master V1.2 — invariant enforcement.
--
--   (a) master_derivations: subject_type must match the non-null subject
--       FK. The V1.1 CHECK only enforced "exactly one FK set"; a buggy or
--       hostile writer could label an instrument_id as subject_type
--       'listing'. Now the DB itself rejects subject_type/FK mismatch.

ALTER TABLE master_derivations
  ADD CONSTRAINT master_derivations_subject_fk_match CHECK (
    (subject_type = 'instrument'
       AND instrument_id IS NOT NULL
       AND instrument_version_id IS NULL AND listing_id IS NULL
       AND listing_version_id IS NULL AND venue_id IS NULL
       AND venue_version_id IS NULL AND instrument_identifier_id IS NULL
       AND listing_identifier_id IS NULL)
    OR (subject_type = 'instrument_version'
       AND instrument_version_id IS NOT NULL
       AND instrument_id IS NULL AND listing_id IS NULL
       AND listing_version_id IS NULL AND venue_id IS NULL
       AND venue_version_id IS NULL AND instrument_identifier_id IS NULL
       AND listing_identifier_id IS NULL)
    OR (subject_type = 'listing'
       AND listing_id IS NOT NULL
       AND instrument_id IS NULL AND instrument_version_id IS NULL
       AND listing_version_id IS NULL AND venue_id IS NULL
       AND venue_version_id IS NULL AND instrument_identifier_id IS NULL
       AND listing_identifier_id IS NULL)
    OR (subject_type = 'listing_version'
       AND listing_version_id IS NOT NULL
       AND instrument_id IS NULL AND instrument_version_id IS NULL
       AND listing_id IS NULL AND venue_id IS NULL
       AND venue_version_id IS NULL AND instrument_identifier_id IS NULL
       AND listing_identifier_id IS NULL)
    OR (subject_type = 'venue'
       AND venue_id IS NOT NULL
       AND instrument_id IS NULL AND instrument_version_id IS NULL
       AND listing_id IS NULL AND listing_version_id IS NULL
       AND venue_version_id IS NULL AND instrument_identifier_id IS NULL
       AND listing_identifier_id IS NULL)
    OR (subject_type = 'venue_version'
       AND venue_version_id IS NOT NULL
       AND instrument_id IS NULL AND instrument_version_id IS NULL
       AND listing_id IS NULL AND listing_version_id IS NULL
       AND venue_id IS NULL AND instrument_identifier_id IS NULL
       AND listing_identifier_id IS NULL)
    OR (subject_type = 'instrument_identifier'
       AND instrument_identifier_id IS NOT NULL
       AND instrument_id IS NULL AND instrument_version_id IS NULL
       AND listing_id IS NULL AND listing_version_id IS NULL
       AND venue_id IS NULL AND venue_version_id IS NULL
       AND listing_identifier_id IS NULL)
    OR (subject_type = 'listing_identifier'
       AND listing_identifier_id IS NOT NULL
       AND instrument_id IS NULL AND instrument_version_id IS NULL
       AND listing_id IS NULL AND listing_version_id IS NULL
       AND venue_id IS NULL AND venue_version_id IS NULL
       AND instrument_identifier_id IS NULL)
  );

COMMIT;
