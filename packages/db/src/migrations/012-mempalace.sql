-- ============================================================================
-- Memory Palace Tables
-- Adds the spatial memory organization system (wings, rooms, drawers, etc.)
-- and the knowledge graph (entities + temporal triples).
-- ============================================================================

-- Wings: top-level groupings (people, projects, domains)
CREATE TABLE IF NOT EXISTS memory_wings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  name STRING NOT NULL,
  description STRING NOT NULL DEFAULT '',
  domains STRING[] NOT NULL DEFAULT '{}',
  drawer_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name),
  INDEX (user_id)
);

-- Rooms: topics within a wing
CREATE TABLE IF NOT EXISTS memory_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wing_id UUID NOT NULL REFERENCES memory_wings(id) ON DELETE CASCADE,
  name STRING NOT NULL,
  description STRING NOT NULL DEFAULT '',
  halls STRING[] NOT NULL DEFAULT '{}',
  drawer_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wing_id, name),
  INDEX (wing_id)
);

-- Drawers: individual memory chunks (the atomic unit)
CREATE TABLE IF NOT EXISTS memory_drawers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES memory_rooms(id) ON DELETE CASCADE,
  wing_id UUID NOT NULL REFERENCES memory_wings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  hall STRING NOT NULL,
  content STRING NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  source_type STRING NOT NULL,
  source_id STRING,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX (user_id, hall),
  INDEX (user_id, created_at DESC),
  INDEX (room_id),
  INDEX (wing_id)
);

-- Closets: compressed summaries of multiple drawers
CREATE TABLE IF NOT EXISTS memory_closets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES memory_rooms(id) ON DELETE CASCADE,
  wing_id UUID NOT NULL REFERENCES memory_wings(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  compressed_content STRING NOT NULL,
  source_drawer_ids UUID[] NOT NULL DEFAULT '{}',
  drawer_count INT NOT NULL DEFAULT 0,
  token_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX (user_id),
  INDEX (room_id)
);

-- Tunnels: cross-wing connections via shared topics
CREATE TABLE IF NOT EXISTS memory_tunnels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  topic STRING NOT NULL,
  connected_room_ids UUID[] NOT NULL DEFAULT '{}',
  connected_wing_ids UUID[] NOT NULL DEFAULT '{}',
  strength FLOAT NOT NULL DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, topic),
  INDEX (user_id)
);

-- Knowledge Graph: entities
CREATE TABLE IF NOT EXISTS knowledge_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  name STRING NOT NULL,
  entity_type STRING NOT NULL,
  properties JSONB NOT NULL DEFAULT '{}',
  aliases STRING[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name, entity_type),
  INDEX (user_id),
  INDEX (user_id, entity_type)
);

-- Knowledge Graph: temporal fact triples
CREATE TABLE IF NOT EXISTS knowledge_triples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  subject STRING NOT NULL,
  predicate STRING NOT NULL,
  object STRING NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  confidence STRING NOT NULL DEFAULT 'moderate',
  source_closet_id UUID REFERENCES memory_closets(id),
  source_drawer_id UUID REFERENCES memory_drawers(id),
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX (user_id),
  INDEX (user_id, subject),
  INDEX (user_id, valid_from, valid_to)
);

-- Episodic memories: full decision episodes
CREATE TABLE IF NOT EXISTS episodic_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  situation_summary STRING NOT NULL,
  domain STRING NOT NULL,
  situation_type STRING NOT NULL,
  context_snapshot JSONB NOT NULL DEFAULT '{}',
  action_taken STRING,
  outcome JSONB,
  feedback_type STRING,
  feedback_detail STRING,
  decision_id UUID REFERENCES decisions(id),
  signal_ids UUID[] NOT NULL DEFAULT '{}',
  drawer_ids UUID[] NOT NULL DEFAULT '{}',
  utility_score FLOAT NOT NULL DEFAULT 0.5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX (user_id, domain, created_at DESC),
  INDEX (user_id, situation_type, created_at DESC),
  INDEX (user_id, utility_score DESC),
  INDEX (decision_id)
);

-- Entity codes for AAAK compression
CREATE TABLE IF NOT EXISTS entity_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  code STRING NOT NULL,
  full_name STRING NOT NULL,
  entity_id UUID REFERENCES knowledge_entities(id),
  UNIQUE (user_id, code),
  INDEX (user_id)
);
