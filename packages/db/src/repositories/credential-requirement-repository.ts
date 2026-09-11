import { query } from '../connection.js';
import type { CredentialRequirementRow } from '../types.js';

export interface RegisterCredentialRequirementInput {
  adapter: string;
  integration: string;
  integrationLabel: string;
  description?: string;
  fieldKey: string;
  fieldLabel: string;
  fieldPlaceholder?: string;
  isSecret?: boolean;
  isOptional?: boolean;
  skills: string[];
}

/**
 * Repository for credential requirements that adapters register.
 *
 * When an adapter (e.g. OpenClaw) adds a skill that needs external credentials
 * (e.g. Twitter API keys), it registers the requirement here. The Setup page
 * reads these to dynamically render integration sections, and the dashboard
 * checks for unmet requirements to flag the user.
 */
export const credentialRequirementRepository = {
  /**
   * Register (upsert) a credential requirement for an adapter/integration.
   */
  async register(input: RegisterCredentialRequirementInput): Promise<CredentialRequirementRow> {
    const result = await query<CredentialRequirementRow>(
      `INSERT INTO credential_requirements
         (installation_id, adapter, integration, integration_label, description, field_key, field_label, field_placeholder, is_secret, is_optional, skills)
       SELECT installation_id, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
         FROM installation_identity
        WHERE singleton = true
       ON CONFLICT (installation_id, adapter, integration, field_key) DO UPDATE SET
         integration_label = EXCLUDED.integration_label,
         description = COALESCE(EXCLUDED.description, credential_requirements.description),
         field_label = EXCLUDED.field_label,
         field_placeholder = COALESCE(EXCLUDED.field_placeholder, credential_requirements.field_placeholder),
         is_secret = EXCLUDED.is_secret,
         is_optional = EXCLUDED.is_optional,
         skills = EXCLUDED.skills
       RETURNING *`,
      [
        input.adapter,
        input.integration,
        input.integrationLabel,
        input.description ?? null,
        input.fieldKey,
        input.fieldLabel,
        input.fieldPlaceholder ?? null,
        input.isSecret ?? false,
        input.isOptional ?? false,
        input.skills,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('installation_identity_unavailable');
    return row;
  },

  /**
   * Get all requirements for a specific adapter.
   */
  async getByAdapter(adapter: string): Promise<CredentialRequirementRow[]> {
    const result = await query<CredentialRequirementRow>(
      `SELECT requirement.*
         FROM credential_requirements AS requirement
         JOIN installation_identity AS owner
           ON owner.singleton = true
          AND owner.installation_id = requirement.installation_id
        WHERE requirement.adapter = $1
        ORDER BY requirement.integration, requirement.field_key`,
      [adapter],
    );
    return result.rows;
  },

  /**
   * Get all requirements for a specific integration (across all adapters).
   */
  async getByIntegration(integration: string): Promise<CredentialRequirementRow[]> {
    const result = await query<CredentialRequirementRow>(
      `SELECT requirement.*
         FROM credential_requirements AS requirement
         JOIN installation_identity AS owner
           ON owner.singleton = true
          AND owner.installation_id = requirement.installation_id
        WHERE requirement.integration = $1
        ORDER BY requirement.adapter, requirement.field_key`,
      [integration],
    );
    return result.rows;
  },

  /**
   * Get all registered requirements.
   */
  async getAll(): Promise<CredentialRequirementRow[]> {
    const result = await query<CredentialRequirementRow>(
      `SELECT requirement.*
         FROM credential_requirements AS requirement
         JOIN installation_identity AS owner
           ON owner.singleton = true
          AND owner.installation_id = requirement.installation_id
        ORDER BY requirement.adapter, requirement.integration, requirement.field_key`,
    );
    return result.rows;
  },

  /**
   * Find requirements for a specific skill (action type).
   * Returns requirements where the skill appears in the skills array.
   */
  async getBySkill(skill: string): Promise<CredentialRequirementRow[]> {
    const result = await query<CredentialRequirementRow>(
      `SELECT requirement.*
         FROM credential_requirements AS requirement
         JOIN installation_identity AS owner
           ON owner.singleton = true
          AND owner.installation_id = requirement.installation_id
        WHERE $1 = ANY(requirement.skills)
        ORDER BY requirement.adapter, requirement.integration`,
      [skill],
    );
    return result.rows;
  },

  /**
   * Get all unique integrations with their requirements.
   * Returns a map of integration -> requirements grouped for rendering.
   */
  async getAllGrouped(): Promise<
    Map<string, { label: string; description: string | null; adapter: string; fields: CredentialRequirementRow[] }>
  > {
    const rows = await this.getAll();
    const grouped = new Map<
      string,
      { label: string; description: string | null; adapter: string; fields: CredentialRequirementRow[] }
    >();

    for (const row of rows) {
      const key = `${row.adapter}:${row.integration}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          label: row.integration_label,
          description: row.description,
          adapter: row.adapter,
          fields: [],
        });
      }
      grouped.get(key)!.fields.push(row);
    }

    return grouped;
  },

  /**
   * Remove a specific requirement.
   */
  async delete(adapter: string, integration: string, fieldKey: string): Promise<boolean> {
    const result = await query(
      `DELETE FROM credential_requirements AS requirement
        USING installation_identity AS owner
        WHERE owner.singleton = true
          AND owner.installation_id = requirement.installation_id
          AND requirement.adapter = $1
          AND requirement.integration = $2
          AND requirement.field_key = $3`,
      [adapter, integration, fieldKey],
    );
    return (result.rowCount ?? 0) > 0;
  },

  /**
   * Remove all requirements for an integration (e.g. when an adapter drops support).
   */
  async deleteIntegration(adapter: string, integration: string): Promise<number> {
    const result = await query(
      `DELETE FROM credential_requirements AS requirement
        USING installation_identity AS owner
        WHERE owner.singleton = true
          AND owner.installation_id = requirement.installation_id
          AND requirement.adapter = $1
          AND requirement.integration = $2`,
      [adapter, integration],
    );
    return result.rowCount ?? 0;
  },
};
