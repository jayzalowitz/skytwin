-- 080-encrypt-memory-and-decisions.sql
-- Extension of the envelope encryption architecture (#374) to the MemPalace 
-- and Decision layers. This follows the precedent set in 066-encrypt-high-value-tables.sql.
--
-- The plaintext columns are NOT dropped here — they stay for the lazy-
-- migration window. Each affected column is encrypted to its sibling
-- `<col>_encrypted BYTES` on first write/read after the user's vault is
-- initialised; the plaintext column is then set to NULL.
--
-- Packed ciphertext format: [IV (12 bytes)] + [tag (16 bytes)] + [ciphertext].
-- Crypto: AES-256-GCM. Key derivation: scrypt(passphrase, per-user salt).

-- ── memory_drawers ──────────────────────────────────────────────────────────
-- Content of a memory drawer (the core "fact" or "note").
ALTER TABLE memory_drawers ADD COLUMN IF NOT EXISTS content_encrypted        BYTES NULL;
ALTER TABLE memory_drawers ADD COLUMN IF NOT EXISTS encryption_key_version INT NOT NULL DEFAULT 1;
ALTER TABLE memory_drawers ALTER COLUMN content DROP NOT NULL;

-- ── memory_closets ──────────────────────────────────────────────────────────
-- Compressed content for archival storage.
ALTER TABLE memory_closets ADD COLUMN IF NOT EXISTS compressed_content_encrypted BYTES NULL;
ALTER TABLE memory_closets ADD COLUMN IF NOT EXISTS encryption_key_version INT NOT NULL DEFAULT 1;
ALTER TABLE memory_closets ALTER COLUMN compressed_content DROP NOT NULL;

-- ── episodic_memories ────────────────────────────────────────────────────────
-- Situation summaries and feedback details.
ALTER TABLE episodic_memories ADD COLUMN IF NOT EXISTS situation_summary_encrypted BYTES NULL;
ALTER TABLE episodic_memories ADD COLUMN IF NOT EXISTS feedback_detail_encrypted    BYTES NULL;
ALTER TABLE episodic_memories ADD COLUMN IF NOT EXISTS encryption_key_version      INT NOT NULL DEFAULT 1;
ALTER TABLE episodic_memories ALTER COLUMN situation_summary DROP NOT NULL;
ALTER TABLE episodic_memories ALTER COLUMN feedback_detail   DROP NOT NULL;

-- ── knowledge_entities ────────────────────────────────────────────────────
-- Entity names and their associated properties.
ALTER TABLE knowledge_entities ADD COLUMN IF NOT EXISTS name_encrypted       BYTES NULL;
ALTER TABLE knowledge_entities ADD COLUMN IF NOT EXISTS properties_encrypted BYTES NULL;
ALTER TABLE knowledge_entities ADD COLUMN IF NOT EXISTS encryption_key_version INT NOT NULL DEFAULT 1;
ALTER TABLE knowledge_entities ALTER COLUMN name        DROP NOT NULL;
ALTER TABLE knowledge_entities ALTER COLUMN properties   DROP NOT NULL;

-- ── knowledge_triples ──────────────────────────────────────────────────────
-- The edges of the knowledge graph: subject, predicate, and object.
ALTER TABLE knowledge_triples ADD COLUMN IF NOT EXISTS subject_encrypted   BYTES NULL;
ALTER TABLE knowledge_triples ADD COLUMN IF NOT EXISTS predicate_encrypted BYTES NULL;
ALTER TABLE knowledge_triples ADD COLUMN IF NOT EXISTS object_encrypted    BYTES NULL;
ALTER TABLE knowledge_triples ADD COLUMN IF NOT EXISTS encryption_key_version INT NOT NULL DEFAULT 1;
ALTER TABLE knowledge_triples ALTER COLUMN subject   DROP NOT NULL;
ALTER TABLE knowledge_triples ALTER COLUMN predicate DROP NOT NULL;
ALTER TABLE knowledge_triples ALTER COLUMN object    DROP NOT NULL;

-- ── decisions ───────────────────────────────────────────────────────────────
-- Raw event logs and interpreted situations.
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS raw_event_encrypted             BYTES NULL;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS interpreted_situation_encrypted  BYTES NULL;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS encryption_key_version           INT NOT NULL DEFAULT 1;
ALTER TABLE decisions ALTER COLUMN raw_event             DROP NOT NULL;
ALTER TABLE decisions ALTER COLUMN interpreted_situation DROP NOT NULL;

-- ── candidate_actions ───────────────────────────────────────────────────────
-- Proposed actions and their parameters.
ALTER TABLE candidate_actions ADD COLUMN IF NOT EXISTS description_encrypted BYTES NULL;
ALTER TABLE candidate_actions ADD COLUMN IF NOT EXISTS parameters_encrypted   BYTES NULL;
ALTER TABLE candidate_actions ADD COLUMN IF NOT EXISTS encryption_key_version INT NOT NULL DEFAULT 1;
ALTER TABLE candidate_actions ALTER COLUMN description DROP NOT NULL;
ALTER TABLE candidate_actions ALTER COLUMN parameters   DROP NOT NULL;

-- ── decision_outcomes ──────────────────────────────────────────────────────
-- The final explanation of why an action was taken.
ALTER TABLE decision_outcomes ADD COLUMN IF NOT EXISTS explanation_encrypted BYTES NULL;
ALTER TABLE decision_outcomes ADD COLUMN IF NOT EXISTS encryption_key_version INT NOT NULL DEFAULT 1;
ALTER TABLE decision_outcomes ALTER COLUMN explanation DROP NOT NULL;
