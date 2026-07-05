import { getPool, closePool, withTransaction } from '../connection.js';
import { seedDemoShowcase } from './demo-showcase.js';

/**
 * Seed the database with sample data for development.
 */
async function seed(): Promise<void> {
  // Ensure the pool is initialized before transacting
  getPool();

  await withTransaction(async (client) => {
    // ========================================================================
    // 1. Create a sample user with autonomy settings
    // ========================================================================
    const userResult = await client.query(
      `INSERT INTO users (id, email, name, trust_tier, autonomy_settings)
       VALUES (
         'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
         'alex@example.com',
         'Alex Thompson',
         -- low_autonomy (not moderate): the trust bar only shows live *progress*
         -- below the top tiers. At low_autonomy Alex is visibly climbing toward
         -- "Handle most things" (50-approval threshold), which is the story the
         -- demo wants — moderate_autonomy renders a flat "Maximum trust" dead-end.
         'low_autonomy',
         $1
       )
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         trust_tier = EXCLUDED.trust_tier,
         autonomy_settings = EXCLUDED.autonomy_settings,
         updated_at = now()
       RETURNING id`,
      [
        JSON.stringify({
          maxAutoSpend: 5000, // $50.00 in cents
          autoApproveRecurring: true,
          requireApprovalForNewVendors: true,
          allowCalendarManagement: true,
          allowEmailDrafts: true,
          allowEmailSend: false,
          notificationPreferences: {
            email: true,
            push: true,
            sms: false,
          },
        }),
      ],
    );
    const userId = userResult.rows[0].id;
    console.log(`[seed] Created user: ${userId}`);

    // ========================================================================
    // 2. Create a twin profile with preferences
    // ========================================================================
    const profileResult = await client.query(
      `INSERT INTO twin_profiles (
        id, user_id, version, preferences, inferences,
        risk_tolerance, spend_norms, communication_style,
        routines, domain_heuristics
      )
      VALUES (
        'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        $1, 1, $2, $3, $4, $5, $6, $7, $8
      )
      ON CONFLICT (user_id) DO UPDATE SET
        version = EXCLUDED.version,
        preferences = EXCLUDED.preferences,
        inferences = EXCLUDED.inferences,
        risk_tolerance = EXCLUDED.risk_tolerance,
        spend_norms = EXCLUDED.spend_norms,
        communication_style = EXCLUDED.communication_style,
        routines = EXCLUDED.routines,
        domain_heuristics = EXCLUDED.domain_heuristics,
        updated_at = now()
      RETURNING id`,
      [
        userId,
        // Preferences drive "What I've learned" + the dashboard's "how well I
        // know you" confidence rollup. source explicit/corrected count as
        // "confirmed" (100%); confidence must be a valid ConfidenceLevel
        // (speculative|low|moderate|high|confirmed — NOT "medium").
        JSON.stringify([
          { domain: 'communication', key: 'response_style', value: 'Keep replies short and to the point', confidence: 'high', source: 'explicit', evidenceIds: [] },
          { domain: 'email', key: 'auto_archive_promo', value: 'Archive promotions and receipts automatically', confidence: 'confirmed', source: 'explicit', evidenceIds: [] },
          { domain: 'email', key: 'snooze_newsletters', value: 'Snooze newsletters to the weekend', confidence: 'high', source: 'corrected', evidenceIds: [] },
          { domain: 'email', key: 'draft_work_replies', value: 'Draft replies to coworkers, but let me send them', confidence: 'high', source: 'explicit', evidenceIds: [] },
          { domain: 'calendar', key: 'protect_morning_focus', value: 'Protect 8–10am for focused work', confidence: 'high', source: 'explicit', evidenceIds: [] },
          { domain: 'calendar', key: 'auto_accept_recurring', value: 'Auto-accept recurring meetings with no conflicts', confidence: 'confirmed', source: 'corrected', evidenceIds: [] },
          { domain: 'calendar', key: 'no_meetings_friday', value: 'Keep Friday afternoons meeting-free', confidence: 'moderate', source: 'explicit', evidenceIds: [] },
          { domain: 'scheduling', key: 'meeting_buffer', value: 'Leave 15 minutes between meetings', confidence: 'moderate', source: 'inferred', evidenceIds: [] },
          { domain: 'finance', key: 'alert_large_charges', value: 'Ask before anything over $50 goes through', confidence: 'high', source: 'explicit', evidenceIds: [] },
          { domain: 'subscriptions', key: 'review_before_renew', value: 'Review subscription renewals before they charge', confidence: 'moderate', source: 'corrected', evidenceIds: [] },
          { domain: 'shopping', key: 'brand_preference', value: 'Prefer Apple and Sony for electronics', confidence: 'high', source: 'explicit', evidenceIds: [] },
          { domain: 'travel', key: 'aisle_seat', value: 'Book the aisle seat when flying', confidence: 'moderate', source: 'inferred', evidenceIds: [] },
        ]),
        // Inferences are things the twin figured out on its own; each carries a
        // human "reasoning" line rendered under the item.
        JSON.stringify([
          { type: 'behavioral', domain: 'calendar', key: 'morning_person', value: 'Most productive before noon', confidence: 'high', supportingEvidenceIds: [], contradictingEvidenceIds: [], observedFrom: 'calendar_patterns', reasoning: 'You schedule deep work in the morning and decline early meetings 14 of the last 20 weekdays.' },
          { type: 'preference', domain: 'email', key: 'prefers_async', value: 'Prefers async over meetings', confidence: 'moderate', supportingEvidenceIds: [], contradictingEvidenceIds: [], observedFrom: 'communication_history', reasoning: 'You often reply "let\'s handle this over email" instead of booking a call.' },
          { type: 'behavioral', domain: 'finance', key: 'cautious_spender', value: 'Careful with money', confidence: 'high', supportingEvidenceIds: [], contradictingEvidenceIds: [], observedFrom: 'transaction_history', reasoning: 'You review nearly every charge over ~$50 before approving it.' },
          { type: 'behavioral', domain: 'communication', key: 'professional_tone', value: 'Professional, warm tone', confidence: 'high', supportingEvidenceIds: [], contradictingEvidenceIds: [], observedFrom: 'sent_mail', reasoning: 'Your sent mail is concise and friendly, signs off with "Best".' },
          { type: 'behavioral', domain: 'calendar', key: 'declines_late_meetings', value: 'Avoids evening meetings', confidence: 'moderate', supportingEvidenceIds: [], contradictingEvidenceIds: [], observedFrom: 'calendar_patterns', reasoning: 'You\'ve declined 6 of the last 7 meetings after 5pm.' },
          { type: 'behavioral', domain: 'health', key: 'morning_exerciser', value: 'Runs in the morning', confidence: 'moderate', supportingEvidenceIds: [], contradictingEvidenceIds: [], observedFrom: 'activity_logs', reasoning: 'Your workouts are logged before 9am on most weekdays.' },
        ]),
        JSON.stringify({
          financial: 'moderate',
          scheduling: 'low',
          communication: 'low',
          purchasing: 'moderate',
        }),
        JSON.stringify({
          groceries: { weekly: 15000, monthly: 60000 },
          subscriptions: { monthly: 5000 },
          dining: { weekly: 7500 },
          transportation: { monthly: 20000 },
        }),
        JSON.stringify({
          tone: 'professional',
          formality: 'moderate',
          verbosity: 'concise',
          emoji_usage: 'minimal',
          signoff: 'Best',
        }),
        JSON.stringify([
          {
            name: 'morning_routine',
            days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
            startTime: '07:00',
            activities: ['check_email', 'review_calendar', 'standup_prep'],
          },
          {
            name: 'weekly_review',
            days: ['friday'],
            startTime: '16:00',
            activities: ['expense_review', 'next_week_planning'],
          },
        ]),
        JSON.stringify({
          email: {
            autoArchivePromotional: true,
            prioritizeFrom: ['team', 'manager'],
            snoozeNewsletters: true,
          },
          calendar: {
            noMeetingsFriday: true,
            lunchBlock: { start: '12:00', end: '13:00' },
            focusTimeMin: 120,
          },
        }),
      ],
    );
    console.log(`[seed] Created twin profile: ${profileResult.rows[0].id}`);

    // ========================================================================
    // 3. Create sample policies
    // ========================================================================
    await client.query(
      `INSERT INTO action_policies (id, user_id, name, domain, rules, priority)
       VALUES
         ('c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f', $1, 'Auto-approve small purchases', 'purchasing', $2, 10),
         ('d4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f80', $1, 'Calendar management', 'scheduling', $3, 5),
         ('e5f6a7b8-c9d0-4e1f-2a3b-4c5d6e7f8091', $1, 'Email draft rules', 'communication', $4, 8)
       ON CONFLICT (id) DO NOTHING`,
      [
        userId,
        JSON.stringify([
          {
            condition: 'amount_cents <= 2000',
            action: 'auto_approve',
            description: 'Auto-approve purchases under $20',
          },
          {
            condition: 'vendor_is_known AND amount_cents <= 5000',
            action: 'auto_approve',
            description: 'Auto-approve known vendor purchases under $50',
          },
          {
            condition: 'amount_cents > 5000',
            action: 'require_approval',
            description: 'Require approval for purchases over $50',
          },
        ]),
        JSON.stringify([
          {
            condition: 'is_recurring_meeting',
            action: 'auto_accept',
            description: 'Auto-accept recurring meetings',
          },
          {
            condition: 'conflicts_with_focus_time',
            action: 'suggest_alternative',
            description: 'Suggest alternatives when conflicting with focus time',
          },
          {
            condition: 'is_friday AND is_afternoon',
            action: 'decline_suggest_alternative',
            description: 'Decline Friday afternoon meetings and suggest alternatives',
          },
        ]),
        JSON.stringify([
          {
            condition: 'recipient_is_external',
            action: 'require_review',
            description: 'Require review for external emails',
          },
          {
            condition: 'recipient_is_team',
            action: 'auto_draft',
            description: 'Auto-draft replies to team members',
          },
        ]),
      ],
    );
    console.log('[seed] Created 3 action policies.');

    // ========================================================================
    // 4. Create sample decisions with outcomes
    // ========================================================================

    // Decision 1: A scheduling decision that was auto-executed
    const decision1Result = await client.query(
      `INSERT INTO decisions (id, user_id, situation_type, raw_event, interpreted_situation, domain, urgency, metadata, source)
       VALUES (
         'f6a7b8c9-d0e1-4f2a-3b4c-5d6e7f809102',
         $1, 'meeting_request', $2, $3, 'scheduling', 'normal', $4, 'google_calendar'
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        userId,
        JSON.stringify({
          type: 'calendar_invite',
          from: 'colleague@company.com',
          subject: 'Weekly sync',
          proposedTime: '2026-03-30T14:00:00Z',
          duration: 30,
        }),
        JSON.stringify({
          type: 'recurring_meeting_request',
          sender: 'known_colleague',
          conflictsWithExisting: false,
          isRecurring: true,
          duringFocusTime: false,
        }),
        JSON.stringify({
          source: 'google_calendar',
          eventId: 'evt_abc123',
        }),
      ],
    );

    if (decision1Result.rows.length > 0) {
      const decision1Id = decision1Result.rows[0].id;

      // Add candidate actions for decision 1
      await client.query(
        `INSERT INTO candidate_actions (id, decision_id, action_type, description, parameters, predicted_user_preference, risk_assessment, reversible, estimated_cost)
         VALUES
           ('01a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c', $1, 'accept', 'Accept the meeting invitation', $2, 'likely_approve', $3, true, NULL),
           ('11a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5d', $1, 'decline', 'Decline the meeting invitation', '{}', 'unlikely', $4, true, NULL)
         ON CONFLICT (id) DO NOTHING`,
        [
          decision1Id,
          JSON.stringify({ response: 'accepted', addToCalendar: true }),
          JSON.stringify({ level: 'low', factors: ['recurring', 'no_conflicts', 'known_sender'] }),
          JSON.stringify({ level: 'low', factors: ['could_miss_important_sync'] }),
        ],
      );

      // Record outcome for decision 1
      await client.query(
        `INSERT INTO decision_outcomes (id, decision_id, selected_action_id, auto_executed, requires_approval, explanation, confidence)
         VALUES (
           '21a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5e',
           $1, '01a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c', true, false,
           'Auto-accepted recurring meeting from known colleague. No conflicts detected and matches calendar management policy.',
           0.92
         )
         ON CONFLICT (id) DO NOTHING`,
        [decision1Id],
      );

      // Explanation for decision 1
      await client.query(
        `INSERT INTO explanation_records (id, decision_id, what_happened, evidence_used, preferences_invoked, confidence_reasoning, action_rationale, correction_guidance, type)
         VALUES (
           '31a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5f',
           $1,
           'Automatically accepted a recurring weekly sync meeting from a known colleague.',
           $2,
           $3,
           'High confidence (0.92) based on: recurring meeting pattern, known sender, no scheduling conflicts, and matching calendar management policy.',
           'The meeting matches the auto-accept policy for recurring meetings from known colleagues with no conflicts.',
           'If you prefer not to auto-accept this type of meeting, update the calendar management policy or lower the trust tier for scheduling actions.',
           'auto_execution'
         )
         ON CONFLICT (id) DO NOTHING`,
        [
          decision1Id,
          JSON.stringify([
            { type: 'policy', ref: 'calendar_management', rule: 'is_recurring_meeting' },
            { type: 'profile', ref: 'routines', detail: 'no_conflict_with_routines' },
          ]),
          ['calendar_management.auto_accept_recurring', 'scheduling.risk_tolerance.low'],
        ],
      );

      console.log(`[seed] Created decision 1 (scheduling) with outcome and explanation.`);
    }

    // Decision 2: A purchasing decision that required approval
    const decision2Result = await client.query(
      `INSERT INTO decisions (id, user_id, situation_type, raw_event, interpreted_situation, domain, urgency, metadata, source)
       VALUES (
         'a7b8c9d0-e1f2-4a3b-4c5d-6e7f80910213',
         $1, 'purchase_suggestion', $2, $3, 'purchasing', 'low', $4, 'email_parser'
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        userId,
        JSON.stringify({
          type: 'subscription_renewal',
          vendor: 'NewService Inc.',
          amount: 7999,
          currency: 'USD',
          description: 'Annual subscription renewal',
        }),
        JSON.stringify({
          type: 'subscription_renewal',
          isNewVendor: true,
          amountCents: 7999,
          exceedsAutoApproveLimit: true,
          isRecurring: true,
        }),
        JSON.stringify({
          source: 'email_parser',
          emailId: 'msg_xyz789',
          vendorDomain: 'newservice.com',
        }),
      ],
    );

    if (decision2Result.rows.length > 0) {
      const decision2Id = decision2Result.rows[0].id;

      // Add candidate actions for decision 2
      await client.query(
        `INSERT INTO candidate_actions (id, decision_id, action_type, description, parameters, predicted_user_preference, risk_assessment, reversible, estimated_cost)
         VALUES
           ('41a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b60', $1, 'approve_renewal', 'Approve the subscription renewal', $2, 'uncertain', $3, true, 7999),
           ('51a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b61', $1, 'cancel_subscription', 'Cancel the subscription', $4, 'unlikely', $5, false, 0)
         ON CONFLICT (id) DO NOTHING`,
        [
          decision2Id,
          JSON.stringify({ action: 'renew', method: 'existing_payment' }),
          JSON.stringify({
            level: 'medium',
            factors: ['new_vendor', 'exceeds_auto_limit', 'annual_commitment'],
          }),
          JSON.stringify({ action: 'cancel', sendConfirmation: true }),
          JSON.stringify({
            level: 'medium',
            factors: ['may_lose_service', 'potential_data_loss'],
          }),
        ],
      );

      // Record outcome (requires approval)
      await client.query(
        `INSERT INTO decision_outcomes (id, decision_id, selected_action_id, auto_executed, requires_approval, escalation_reason, explanation, confidence)
         VALUES (
           '61a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b62',
           $1, '41a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b60', false, true,
           'Amount exceeds auto-approve limit and vendor is new',
           'Recommending renewal approval but escalating because: (1) $79.99 exceeds the $50 auto-approve limit, and (2) this is a new vendor not previously approved.',
           0.65
         )
         ON CONFLICT (id) DO NOTHING`,
        [decision2Id],
      );

      // Approval request for decision 2
      await client.query(
        `INSERT INTO approval_requests (id, user_id, decision_id, candidate_action, reason, urgency, status, expires_at)
         VALUES (
           '71a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b63',
           $1, $2, $3,
           'Subscription renewal of $79.99 from NewService Inc. exceeds auto-approve limit and is from a new vendor.',
           'low', 'pending', now() + INTERVAL '7 days'
         )
         ON CONFLICT (id) DO NOTHING`,
        [
          userId,
          decision2Id,
          JSON.stringify({
            actionType: 'approve_renewal',
            description: 'Approve the subscription renewal',
            estimatedCost: 7999,
            vendor: 'NewService Inc.',
          }),
        ],
      );

      // Feedback for decision 1 (user approved the scheduling decision)
      await client.query(
        `INSERT INTO feedback_events (id, user_id, decision_id, type, data)
         VALUES (
           '81a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b64',
           $1,
           'f6a7b8c9-d0e1-4f2a-3b4c-5d6e7f809102',
           'implicit_approval',
           $2
         )
         ON CONFLICT (id) DO NOTHING`,
        [
          userId,
          JSON.stringify({
            source: 'no_override',
            elapsedMinutes: 120,
            description: 'User did not override the auto-accepted meeting within 2 hours.',
          }),
        ],
      );

      console.log(`[seed] Created decision 2 (purchasing) with outcome, approval request, and feedback.`);
    }

    // ========================================================================
    // 5. Create some normalized preferences
    // ========================================================================
    await client.query(
      `INSERT INTO preferences (id, user_id, domain, key, value, confidence, source, evidence, version)
       VALUES
         ('91a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b65', $1, 'communication', 'response_style', '"concise"', 'high', 'explicit', $2, 1),
         ('a1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b66', $1, 'scheduling', 'meeting_buffer_minutes', '15', 'medium', 'inferred', $3, 1),
         ('b1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b67', $1, 'purchasing', 'max_auto_approve_cents', '5000', 'high', 'explicit', $4, 1)
       ON CONFLICT (id) DO NOTHING`,
      [
        userId,
        JSON.stringify([
          { type: 'user_stated', date: '2026-01-15', detail: 'User set preference during onboarding' },
        ]),
        JSON.stringify([
          { type: 'calendar_analysis', date: '2026-02-01', detail: 'Observed 15-min gaps between meetings in 80% of cases' },
        ]),
        JSON.stringify([
          { type: 'user_stated', date: '2026-01-15', detail: 'User configured during autonomy settings setup' },
        ]),
      ],
    );
    console.log('[seed] Created 3 normalized preferences.');

    // ========================================================================
    // 6. Additional sample users
    // ========================================================================

    // Power User Pat — moderate_autonomy, all domains enabled
    const patResult = await client.query(
      `INSERT INTO users (id, email, name, trust_tier, autonomy_settings)
       VALUES (
         'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
         'pat@example.com',
         'Power User Pat',
         'moderate_autonomy',
         $1
       )
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         trust_tier = EXCLUDED.trust_tier,
         autonomy_settings = EXCLUDED.autonomy_settings,
         updated_at = now()
       RETURNING id`,
      [
        JSON.stringify({
          maxAutoSpend: 10000,
          autoApproveRecurring: true,
          requireApprovalForNewVendors: false,
          allowCalendarManagement: true,
          allowEmailDrafts: true,
          allowEmailSend: true,
          enabledDomains: [
            'email', 'calendar', 'subscriptions', 'shopping', 'travel',
            'finance', 'smart_home', 'tasks', 'social_media', 'documents', 'health',
          ],
          notificationPreferences: {
            email: true,
            push: true,
            sms: true,
          },
        }),
      ],
    );
    console.log(`[seed] Created user: Power User Pat (${patResult.rows[0].id})`);

    // Cautious Carol — observer, email only
    const carolResult = await client.query(
      `INSERT INTO users (id, email, name, trust_tier, autonomy_settings)
       VALUES (
         'c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7a',
         'carol@example.com',
         'Cautious Carol',
         'observer',
         $1
       )
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         trust_tier = EXCLUDED.trust_tier,
         autonomy_settings = EXCLUDED.autonomy_settings,
         updated_at = now()
       RETURNING id`,
      [
        JSON.stringify({
          maxAutoSpend: 0,
          autoApproveRecurring: false,
          requireApprovalForNewVendors: true,
          allowCalendarManagement: false,
          allowEmailDrafts: false,
          allowEmailSend: false,
          enabledDomains: ['email'],
          notificationPreferences: {
            email: true,
            push: false,
            sms: false,
          },
        }),
      ],
    );
    console.log(`[seed] Created user: Cautious Carol (${carolResult.rows[0].id})`);

    // ========================================================================
    // 7. Sample decisions for new domains (Alex user)
    // ========================================================================

    // Finance domain decision: auto-categorize coffee charge
    const finDecisionResult = await client.query(
      `INSERT INTO decisions (id, user_id, situation_type, raw_event, interpreted_situation, domain, urgency, metadata, source)
       VALUES (
         'b8c9d0e1-f2a3-4b4c-5d6e-7f8091021314',
         $1, 'finance_operation', $2, $3, 'finance', 'low', $4, 'bank_feed'
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        userId,
        JSON.stringify({
          type: 'transaction',
          vendor: 'Starbucks',
          amount: 575,
          currency: 'USD',
          description: 'Grande latte',
        }),
        JSON.stringify({
          type: 'small_known_vendor_charge',
          amountCents: 575,
          isRecurring: true,
          vendorKnown: true,
          categoryMatch: 'food_beverage',
        }),
        JSON.stringify({
          source: 'bank_feed',
          transactionId: 'txn_fin_001',
        }),
      ],
    );

    if (finDecisionResult.rows.length > 0) {
      const finDecisionId = finDecisionResult.rows[0].id;
      await client.query(
        `INSERT INTO decision_outcomes (id, decision_id, selected_action_id, auto_executed, requires_approval, explanation, confidence)
         VALUES (
           'c9d0e1f2-a3b4-4c5d-6e7f-809102131415',
           $1, NULL, true, false,
           'Auto-categorized small coffee charge from known vendor Starbucks as food_beverage.',
           0.95
         )
         ON CONFLICT (id) DO NOTHING`,
        [finDecisionId],
      );
      console.log(`[seed] Created finance domain decision for Alex.`);
    }

    // Smart home domain decision: morning routine activation
    const homeDecisionResult = await client.query(
      `INSERT INTO decisions (id, user_id, situation_type, raw_event, interpreted_situation, domain, urgency, metadata, source)
       VALUES (
         'd0e1f2a3-b4c5-4d6e-7f80-910213141516',
         $1, 'smart_home', $2, $3, 'smart_home', 'normal', $4, 'smart_home_hub'
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        userId,
        JSON.stringify({
          type: 'routine_trigger',
          trigger: 'morning_schedule',
          devices: ['lights', 'coffee_maker', 'speaker'],
        }),
        JSON.stringify({
          type: 'scheduled_routine',
          routineName: 'morning_routine',
          devicesAffected: 3,
          isEstablishedRoutine: true,
        }),
        JSON.stringify({
          source: 'smart_home_hub',
          routineId: 'routine_morning_001',
        }),
      ],
    );

    if (homeDecisionResult.rows.length > 0) {
      const homeDecisionId = homeDecisionResult.rows[0].id;
      await client.query(
        `INSERT INTO decision_outcomes (id, decision_id, selected_action_id, auto_executed, requires_approval, explanation, confidence)
         VALUES (
           'e1f2a3b4-c5d6-4e7f-8091-021314151617',
           $1, NULL, true, false,
           'Activated morning routine: turned on lights, started coffee maker, began news briefing.',
           0.97
         )
         ON CONFLICT (id) DO NOTHING`,
        [homeDecisionId],
      );
      console.log(`[seed] Created smart home domain decision for Alex.`);
    }

    // Task domain decision: create task from email
    const taskDecisionResult = await client.query(
      `INSERT INTO decisions (id, user_id, situation_type, raw_event, interpreted_situation, domain, urgency, metadata, source)
       VALUES (
         'f2a3b4c5-d6e7-4f80-9102-131415161718',
         $1, 'task_management', $2, $3, 'tasks', 'normal', $4, 'email_parser'
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        userId,
        JSON.stringify({
          type: 'task_create',
          origin: 'email',
          emailFrom: 'manager@company.com',
          subject: 'Update Q2 report by Friday',
        }),
        JSON.stringify({
          type: 'email_action_item',
          extractedTask: 'Update Q2 report',
          dueDate: '2026-04-04',
          priority: 'normal',
        }),
        JSON.stringify({
          source: 'email_parser',
          emailId: 'msg_task_001',
        }),
      ],
    );

    if (taskDecisionResult.rows.length > 0) {
      const taskDecisionId = taskDecisionResult.rows[0].id;
      await client.query(
        `INSERT INTO decision_outcomes (id, decision_id, selected_action_id, auto_executed, requires_approval, explanation, confidence)
         VALUES (
           'a3b4c5d6-e7f8-4091-0213-141516171819',
           $1, NULL, true, false,
           'Created task "Update Q2 report" with due date April 4 from manager email.',
           0.88
         )
         ON CONFLICT (id) DO NOTHING`,
        [taskDecisionId],
      );
      console.log(`[seed] Created task domain decision for Alex.`);
    }

    // Document domain decision: auto-file invoice
    const docDecisionResult = await client.query(
      `INSERT INTO decisions (id, user_id, situation_type, raw_event, interpreted_situation, domain, urgency, metadata, source)
       VALUES (
         'b4c5d6e7-f809-4102-1314-151617181920',
         $1, 'document_management', $2, $3, 'documents', 'low', $4, 'document_scanner'
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        userId,
        JSON.stringify({
          type: 'document_file',
          documentName: 'Invoice-2026-0342.pdf',
          documentType: 'invoice',
        }),
        JSON.stringify({
          type: 'auto_file_recognized_document',
          documentType: 'invoice',
          targetFolder: 'Finance/Invoices/2026',
          matchConfidence: 0.94,
        }),
        JSON.stringify({
          source: 'document_scanner',
          documentId: 'doc_inv_001',
        }),
      ],
    );

    if (docDecisionResult.rows.length > 0) {
      const docDecisionId = docDecisionResult.rows[0].id;
      await client.query(
        `INSERT INTO decision_outcomes (id, decision_id, selected_action_id, auto_executed, requires_approval, explanation, confidence)
         VALUES (
           'c5d6e7f8-0910-4213-1415-161718192021',
           $1, NULL, true, false,
           'Auto-filed Invoice-2026-0342.pdf to Finance/Invoices/2026 folder.',
           0.94
         )
         ON CONFLICT (id) DO NOTHING`,
        [docDecisionId],
      );
      console.log(`[seed] Created document domain decision for Alex.`);
    }

    // Health domain decision: log daily weight
    const healthDecisionResult = await client.query(
      `INSERT INTO decisions (id, user_id, situation_type, raw_event, interpreted_situation, domain, urgency, metadata, source)
       VALUES (
         'd6e7f809-1021-4314-1516-171819202122',
         $1, 'health_wellness', $2, $3, 'health', 'low', $4, 'health_device'
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        userId,
        JSON.stringify({
          type: 'metric_log',
          metric: 'weight',
          value: 175.2,
          unit: 'lbs',
          device: 'smart_scale',
        }),
        JSON.stringify({
          type: 'routine_health_metric',
          metric: 'weight',
          withinNormalRange: true,
          isEstablishedPattern: true,
        }),
        JSON.stringify({
          source: 'health_device',
          deviceId: 'scale_001',
        }),
      ],
    );

    if (healthDecisionResult.rows.length > 0) {
      const healthDecisionId = healthDecisionResult.rows[0].id;
      await client.query(
        `INSERT INTO decision_outcomes (id, decision_id, selected_action_id, auto_executed, requires_approval, explanation, confidence)
         VALUES (
           'e7f80910-2131-4415-1617-181920212223',
           $1, NULL, true, false,
           'Auto-logged daily weight measurement of 175.2 lbs from smart scale.',
           0.99
         )
         ON CONFLICT (id) DO NOTHING`,
        [healthDecisionId],
      );
      console.log(`[seed] Created health domain decision for Alex.`);
    }

    // Social domain decision: mute spam conversation
    const socialDecisionResult = await client.query(
      `INSERT INTO decisions (id, user_id, situation_type, raw_event, interpreted_situation, domain, urgency, metadata, source)
       VALUES (
         'f8091021-3141-4516-1718-192021222324',
         $1, 'social_media', $2, $3, 'social_media', 'low', $4, 'social_connector'
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        userId,
        JSON.stringify({
          type: 'spam_detected',
          platform: 'twitter',
          author: '@bot98765',
          content: 'Win FREE crypto NOW! Click here!!!',
        }),
        JSON.stringify({
          type: 'detected_spam',
          spamScore: 0.98,
          platform: 'twitter',
          action: 'mute',
        }),
        JSON.stringify({
          source: 'social_connector',
          postId: 'tw_spam_001',
        }),
      ],
    );

    if (socialDecisionResult.rows.length > 0) {
      const socialDecisionId = socialDecisionResult.rows[0].id;
      await client.query(
        `INSERT INTO decision_outcomes (id, decision_id, selected_action_id, auto_executed, requires_approval, explanation, confidence)
         VALUES (
           '09102131-4151-4617-1819-202122232425',
           $1, NULL, true, false,
           'Auto-muted spam conversation from @bot98765 (spam score: 0.98).',
           0.98
         )
         ON CONFLICT (id) DO NOTHING`,
        [socialDecisionId],
      );
      console.log(`[seed] Created social domain decision for Alex.`);
    }

    // ========================================================================
    // 8. Rich, "live-looking" demo for the SAMPLE PROFILE (Alex Thompson).
    //
    // This is the profile the web onboarding loads via "Try with a sample
    // profile", so it must look alive on first glance: real to-dos sitting in
    // the approvals queue, a populated daily briefing, and a mix of handled
    // activity — all phrased for a human (no internal jargon).
    //
    // Everything here is dated RELATIVE to now() and upserts on a fixed id, so
    // re-running `pnpm db:seed` always refreshes it: approvals never drift into
    // "expired", the briefing is always "today", and recent activity stays
    // recent. The live-digest builder (apps/api live-digest.ts) reconstructs
    // each item from raw_event = { source, type, data }, so raw_event is shaped
    // that way here to yield real titles/bodies instead of generic fallbacks.
    // ========================================================================

    // Mark the sample profile as having Gmail + Google Calendar connected. The
    // briefing's live digest treats "no connected accounts" as cold-start and
    // hides everything (source-coverage.ts computeCoverage → coldStart), so
    // without this the rich to-dos below never render. Tokens are intentionally
    // NULL — nothing here can actually call Google (db-token-store returns "no
    // usable token" for a NULL row), it only represents the connection so the
    // digest, coverage panel, and "connected" chrome reflect a real user.
    await client.query(
      `INSERT INTO oauth_tokens
         (id, user_id, provider, account_email, scopes, expires_at, encryption_key_version, created_at, updated_at)
       VALUES
         ('ac000001-0000-4000-8000-000000000001', $1, 'google', 'alex@example.com',
          ARRAY['https://www.googleapis.com/auth/gmail.modify','https://www.googleapis.com/auth/calendar'],
          now() + INTERVAL '30 days', 1, now(), now())
       ON CONFLICT (user_id, provider, account_email) DO UPDATE SET
         scopes = EXCLUDED.scopes,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()`,
      [userId],
    );
    console.log('[seed] Marked the sample profile as Gmail + Calendar connected (synthetic, NULL tokens).');

    interface DemoOutcome {
      autoExecuted: boolean;
      requiresApproval: boolean;
      escalationReason?: string;
      explanation: string;
      confidence: number;
      selectedAction?: {
        id: string;
        type: string;
        description: string;
        parameters: Record<string, unknown>;
        reversible: boolean;
        estimatedCost: number | null;
      };
    }
    interface DemoApproval {
      id: string;
      candidateAction: Record<string, unknown>;
      reason: string;
      urgency: string;
      confirmationLevel?: 'single' | 'dual';
      expiresInDays: number;
    }
    interface DemoDecision {
      id: string;
      outcomeId: string;
      situationType: string;
      domain: string;
      urgency: string;
      source: string;
      eventType: string;
      data: Record<string, unknown>;
      summary: string;
      minutesAgo: number;
      outcome: DemoOutcome;
      approval?: DemoApproval;
    }

    const demoDecisions: DemoDecision[] = [
      // ---- TO-DOs: things sitting in the approvals queue, needing Alex ----
      {
        id: 'de000001-0000-4000-8000-000000000001',
        outcomeId: 'ea000001-0000-4000-8000-000000000001',
        situationType: 'email_reply',
        domain: 'communication',
        urgency: 'high',
        source: 'gmail',
        eventType: 'email_received',
        data: {
          subject: 'Re: SkyTwin pilot — pricing & timeline',
          from: 'Dana Ruiz <dana@brightpath.io>',
          to: 'alex@example.com',
          snippet:
            "Thanks Alex — can you confirm the pilot start date and send over the pricing tiers we discussed? We'd love to get sign-off this week.",
          authoringTier: 'inbox_personal',
        },
        summary: 'Dana at BrightPath asked for the pilot start date and pricing tiers',
        minutesAgo: 42,
        outcome: {
          autoExecuted: false,
          requiresApproval: true,
          escalationReason: 'External recipient — email sends always go to you first',
          explanation:
            'Drafted a reply to Dana confirming the pilot start date and pricing. Held for your review because it goes to an external client.',
          confidence: 0.82,
          selectedAction: {
            id: 'ca000001-0000-4000-8000-000000000001',
            type: 'draft_email',
            description: 'Send the reply I drafted to Dana at BrightPath',
            parameters: {
              to: 'dana@brightpath.io',
              subject: 'Re: SkyTwin pilot — pricing & timeline',
              draftBody:
                'Hi Dana,\n\nGreat to hear you\'re ready to move. We can start the pilot on Monday, July 14. Pricing tiers are: Starter $2k/mo, Team $5k/mo, and Scale $9k/mo — all month-to-month for the pilot.\n\nHappy to hop on a quick call if that\'s easier.\n\nBest,\nAlex',
              summary: 'Reply to Dana with the pilot start date and pricing tiers',
            },
            reversible: true,
            estimatedCost: 0,
          },
        },
        approval: {
          id: 'ab000001-0000-4000-8000-000000000001',
          candidateAction: {
            actionType: 'send_email',
            description: 'Send the reply I drafted to Dana at BrightPath',
            parameters: {
              to: 'dana@brightpath.io',
              subject: 'Re: SkyTwin pilot — pricing & timeline',
              draftBody:
                'Hi Dana,\n\nGreat to hear you\'re ready to move. We can start the pilot on Monday, July 14. Pricing tiers are: Starter $2k/mo, Team $5k/mo, and Scale $9k/mo — all month-to-month for the pilot.\n\nHappy to hop on a quick call if that\'s easier.\n\nBest,\nAlex',
              summary: 'Reply to Dana with the pilot start date and pricing',
            },
            estimatedCost: 0,
            reasoning:
              'Dana asked for the pilot start date and pricing tiers. I drafted a reply in your usual concise style.',
          },
          reason:
            'This reply goes to an external client. Review the draft, then I\'ll send it.',
          urgency: 'high',
          expiresInDays: 2,
        },
      },
      {
        id: 'de000002-0000-4000-8000-000000000002',
        outcomeId: 'ea000002-0000-4000-8000-000000000002',
        situationType: 'purchase_suggestion',
        domain: 'purchasing',
        urgency: 'medium',
        source: 'gmail',
        eventType: 'email_received',
        data: {
          subject: 'Your Figma annual plan renews July 8',
          from: 'Figma Billing <billing@figma.com>',
          snippet:
            'Your annual Figma Organization plan ($79.99) will renew automatically on July 8. No action needed to continue.',
          authoringTier: 'inbox_automated',
        },
        summary: 'Figma annual plan ($79.99) renews July 8 — over the auto-approve limit',
        minutesAgo: 180,
        outcome: {
          autoExecuted: false,
          requiresApproval: true,
          escalationReason: '$79.99 is over your $50 auto-approve limit',
          explanation:
            'Figma\'s annual renewal is $79.99, which is over your $50 auto-approve limit, so I\'m checking with you before it renews.',
          confidence: 0.68,
          selectedAction: {
            id: 'ca000002-0000-4000-8000-000000000002',
            type: 'approve_renewal',
            description: 'Approve the $79.99 Figma annual renewal',
            parameters: { vendor: 'Figma', summary: 'Renew Figma annual plan ($79.99)' },
            reversible: true,
            estimatedCost: 7999,
          },
        },
        approval: {
          id: 'ab000002-0000-4000-8000-000000000002',
          candidateAction: {
            actionType: 'approve_renewal',
            description: 'Approve the $79.99 Figma annual renewal',
            parameters: { vendor: 'Figma', summary: 'Renew Figma annual plan ($79.99)' },
            estimatedCost: 7999,
            reasoning:
              'You use Figma regularly, but $79.99 is over your $50 auto-approve limit, so this one is your call.',
          },
          reason:
            'This $79.99 renewal is over your $50 auto-approve limit. Approve it, or I\'ll let it lapse.',
          urgency: 'medium',
          expiresInDays: 3,
        },
      },
      {
        id: 'de000003-0000-4000-8000-000000000003',
        outcomeId: 'ea000003-0000-4000-8000-000000000003',
        situationType: 'finance_operation',
        domain: 'finance',
        urgency: 'high',
        source: 'gmail',
        eventType: 'email_received',
        data: {
          subject: 'Invoice #2041 from Northwind Design — due July 7',
          from: 'Accounts Payable <ap@northwind.design>',
          snippet:
            'Invoice #2041 for $1,250.00 is due July 7. Please remit payment to the account on file. Thank you for your business.',
          authoringTier: 'inbox_personal',
        },
        summary: 'Invoice #2041 from Northwind Design for $1,250 is due July 7',
        minutesAgo: 300,
        outcome: {
          autoExecuted: false,
          requiresApproval: true,
          escalationReason: '$1,250 exceeds your auto-approve limit and Northwind is a new payee',
          explanation:
            'Northwind Design sent invoice #2041 for $1,250, due July 7. It\'s a new payee and well over your limit, so I\'ll need you to confirm the payment.',
          confidence: 0.6,
          selectedAction: {
            id: 'ca000003-0000-4000-8000-000000000003',
            type: 'pay_invoice',
            description: 'Pay invoice #2041 to Northwind Design ($1,250.00)',
            parameters: {
              payee: 'Northwind Design',
              amount: 125000,
              summary: 'Pay invoice #2041 ($1,250)',
            },
            reversible: false,
            estimatedCost: 125000,
          },
        },
        approval: {
          id: 'ab000003-0000-4000-8000-000000000003',
          candidateAction: {
            actionType: 'pay_invoice',
            description: 'Pay invoice #2041 to Northwind Design ($1,250.00)',
            parameters: {
              payee: 'Northwind Design',
              amount: 125000,
              summary: 'Pay invoice #2041 ($1,250)',
            },
            estimatedCost: 125000,
            reasoning:
              'A $1,250 payment to a payee you haven\'t paid before — high-value and irreversible, so it needs a two-step confirmation.',
          },
          reason:
            'This is $1,250 to a payee you haven\'t paid before. I\'ll ask you to confirm twice.',
          urgency: 'high',
          confirmationLevel: 'dual',
          expiresInDays: 2,
        },
      },
      {
        id: 'de000004-0000-4000-8000-000000000004',
        outcomeId: 'ea000004-0000-4000-8000-000000000004',
        situationType: 'calendar_invite',
        domain: 'scheduling',
        urgency: 'medium',
        source: 'google_calendar',
        eventType: 'event_invite',
        data: {
          title: 'Q3 Planning Offsite',
          summary: 'Q3 Planning Offsite',
          organizer: 'Priya Nair <priya@example.com>',
          description:
            'Full-day offsite to lock in Q3 goals. Lunch provided. Please RSVP by Friday so we can finalize the room.',
          attendees: [{ email: 'priya@example.com' }, { email: 'alex@example.com' }],
          authoringTier: 'inbox_personal',
        },
        summary: 'Priya invited you to the Q3 Planning Offsite — RSVP by Friday',
        minutesAgo: 520,
        outcome: {
          autoExecuted: false,
          // Has a pending approval, so the outcome must agree it needs you —
          // otherwise the digest treats it as an FYI while the queue shows it
          // pending, and the seeded risk tier drops to 'low'.
          requiresApproval: true,
          escalationReason: 'New calendar invite — RSVPs always come to you',
          explanation:
            'New calendar invite from Priya for the Q3 Planning Offsite. Invites always come to you for an RSVP.',
          confidence: 0.9,
          selectedAction: {
            id: 'ca000004-0000-4000-8000-000000000004',
            type: 'respond_to_event',
            description: 'RSVP to the Q3 Planning Offsite',
            parameters: {
              eventTitle: 'Q3 Planning Offsite',
              summary: 'RSVP: Q3 Planning Offsite (Friday deadline)',
            },
            reversible: true,
            estimatedCost: null,
          },
        },
        approval: {
          id: 'ab000004-0000-4000-8000-000000000004',
          candidateAction: {
            actionType: 'respond_to_event',
            description: 'RSVP to the Q3 Planning Offsite',
            parameters: {
              eventTitle: 'Q3 Planning Offsite',
              summary: 'RSVP: Q3 Planning Offsite (Friday deadline)',
            },
            estimatedCost: 0,
            reasoning:
              'Priya asked for an RSVP by Friday. Accept, decline, or propose another time.',
          },
          reason: 'Priya invited you to the Q3 Planning Offsite and asked for an RSVP by Friday.',
          urgency: 'medium',
          expiresInDays: 4,
        },
      },
      {
        id: 'de000005-0000-4000-8000-000000000005',
        outcomeId: 'ea000005-0000-4000-8000-000000000005',
        situationType: 'security_alert',
        domain: 'security',
        urgency: 'critical',
        source: 'gmail',
        eventType: 'email_received',
        data: {
          subject: 'Security alert: new sign-in to your Google Account',
          from: 'Google <no-reply@accounts.google.com>',
          snippet:
            'A new sign-in from Lisbon, Portugal was detected on your account. If this was you, no action is needed. If not, secure your account now.',
          authoringTier: 'inbox_automated',
        },
        summary: 'New Google sign-in from Lisbon, Portugal — confirm it was you',
        minutesAgo: 90,
        outcome: {
          autoExecuted: false,
          requiresApproval: false,
          escalationReason: 'Security alerts are always sent to you — never auto-handled',
          explanation:
            'Google flagged a new sign-in from Lisbon. Security alerts always come straight to you — I never act on them for you.',
          confidence: 0.99,
        },
      },
      // ---- FYIs: handled automatically, shown so you stay in the loop ----
      {
        id: 'de000006-0000-4000-8000-000000000006',
        outcomeId: 'ea000006-0000-4000-8000-000000000006',
        situationType: 'meeting_request',
        domain: 'scheduling',
        urgency: 'low',
        source: 'google_calendar',
        eventType: 'event_invite',
        data: {
          title: 'Eng Standup (daily)',
          summary: 'Eng Standup (daily)',
          organizer: 'Eng Team <team@example.com>',
          description: 'Daily 15-minute standup. Recurring.',
          authoringTier: 'inbox_personal',
        },
        summary: 'Recurring daily Eng Standup',
        minutesAgo: 610,
        outcome: {
          autoExecuted: true,
          requiresApproval: false,
          explanation: 'Accepted your recurring daily Eng Standup — no conflicts on your calendar.',
          confidence: 0.95,
        },
      },
      {
        id: 'de000007-0000-4000-8000-000000000007',
        outcomeId: 'ea000007-0000-4000-8000-000000000007',
        situationType: 'email_triage',
        domain: 'communication',
        urgency: 'low',
        source: 'gmail',
        eventType: 'email_received',
        data: {
          subject: 'The Daily Stoic — Wednesday',
          from: 'The Daily Stoic <newsletter@dailystoic.com>',
          snippet: 'Today\'s meditation: the obstacle is the way…',
          authoringTier: 'inbox_broadcast',
        },
        summary: 'Daily Stoic newsletter',
        minutesAgo: 700,
        outcome: {
          autoExecuted: true,
          requiresApproval: false,
          explanation: 'Archived a Daily Stoic newsletter — matches your "snooze newsletters" preference.',
          confidence: 0.9,
          selectedAction: {
            id: 'ca000007-0000-4000-8000-000000000007',
            type: 'archive_email',
            description: 'Archive the newsletter',
            parameters: {},
            reversible: true,
            estimatedCost: null,
          },
        },
      },
      {
        id: 'de000008-0000-4000-8000-000000000008',
        outcomeId: 'ea000008-0000-4000-8000-000000000008',
        situationType: 'finance_operation',
        domain: 'finance',
        urgency: 'low',
        source: 'app',
        eventType: 'transaction',
        data: {
          title: 'Blue Bottle Coffee — $5.75',
          body: 'Card ending 4242 · categorized as Food & Drink',
          authoringTier: 'inbox_automated',
        },
        summary: 'Blue Bottle Coffee charge — $5.75',
        minutesAgo: 800,
        outcome: {
          autoExecuted: true,
          requiresApproval: false,
          explanation: 'Categorized a $5.75 Blue Bottle Coffee charge as Food & Drink.',
          confidence: 0.96,
        },
      },
      {
        id: 'de000009-0000-4000-8000-000000000009',
        outcomeId: 'ea000009-0000-4000-8000-000000000009',
        situationType: 'document_management',
        domain: 'documents',
        urgency: 'low',
        source: 'filesystem',
        eventType: 'file_indexed',
        data: {
          fileName: 'Invoice-Northwind-2041.pdf',
          excerpt: 'Filed to Finance/Invoices/2026',
          authoringTier: 'authored_originated',
        },
        summary: 'Filed Invoice-Northwind-2041.pdf',
        minutesAgo: 305,
        outcome: {
          autoExecuted: true,
          requiresApproval: false,
          explanation: 'Filed Invoice-Northwind-2041.pdf into Finance/Invoices/2026.',
          confidence: 0.94,
        },
      },
      {
        id: 'de00000a-0000-4000-8000-00000000000a',
        outcomeId: 'ea00000a-0000-4000-8000-00000000000a',
        situationType: 'health_wellness',
        domain: 'health',
        urgency: 'low',
        source: 'app',
        eventType: 'metric_log',
        data: {
          title: 'Morning run logged — 3.2 mi',
          body: '28:14 · avg 8:49/mi',
          authoringTier: 'inbox_automated',
        },
        summary: 'Logged a 3.2 mile morning run',
        minutesAgo: 540,
        outcome: {
          autoExecuted: true,
          requiresApproval: false,
          explanation: 'Logged your 3.2 mile morning run (28:14).',
          confidence: 0.99,
        },
      },
    ];

    // Keep the sample profile's digest crisp and human-meaningful: remove any
    // of Alex's legacy/low-quality decisions whose raw_event has no nested
    // `data` (the pre-refactor flat seed rows from sections 4 & 7, plus any
    // worker-generated "reactive" memory items). Those render as generic
    // "<situation> needs review" lines and repeated one-liners in the live
    // digest — exactly the sparse, robotic look we're fixing. The curated
    // decisions below (all carry `data`) fully replace that surface.
    //
    // Children are cleared first because their FKs to decisions are NO ACTION
    // (memory_action_opportunities is ON DELETE SET NULL, so it's left alone).
    // The subtree has real depth from worker-run items:
    //   execution_results / execution_events → execution_plans → candidate_actions
    //   decision_outcomes → { candidate_actions, execution_plans }
    // so the order below is dependents-before-parents, not a flat loop.
    const flatDecisionFilter = `SELECT id FROM decisions WHERE user_id = $1 AND raw_event->'data' IS NULL`;
    const flatPlanFilter = `SELECT id FROM execution_plans WHERE decision_id IN (${flatDecisionFilter})`;

    // 1. execution subtree (keyed on plan_id)
    await client.query(`DELETE FROM execution_results WHERE plan_id IN (${flatPlanFilter})`, [userId]);
    await client.query(`DELETE FROM execution_events WHERE plan_id IN (${flatPlanFilter})`, [userId]);
    // 2. decision_outcomes — references BOTH candidate_actions and execution_plans
    await client.query(`DELETE FROM decision_outcomes WHERE decision_id IN (${flatDecisionFilter})`, [userId]);
    // 3. execution_plans — references candidate_actions
    await client.query(`DELETE FROM execution_plans WHERE decision_id IN (${flatDecisionFilter})`, [userId]);
    // 4. remaining decision_id-keyed children
    for (const childTable of [
      'candidate_actions',
      'approval_requests',
      'explanation_records',
      'feedback_events',
      'skill_gap_log',
      'episodic_memories',
    ]) {
      await client.query(
        `DELETE FROM ${childTable} WHERE decision_id IN (${flatDecisionFilter})`,
        [userId],
      );
    }
    const cleanup = await client.query(
      `DELETE FROM decisions WHERE user_id = $1 AND raw_event->'data' IS NULL`,
      [userId],
    );
    console.log(`[seed] Cleaned up ${cleanup.rowCount ?? 0} legacy flat decisions for the sample profile.`);

    for (const d of demoDecisions) {
      // raw_event carries the signal two ways on purpose:
      //   • nested `data` — how the live-digest builder reads titles/bodies
      //     (toSignalText reads raw_event.data.{subject,title,snippet,…}); and
      //   • flat top-level `from`/`subject`/`body` — how the approvals card
      //     renders "who it's from / subject" (apps/api approvals.ts reads
      //     raw_event.{from,subject,body} directly).
      // Deriving the flat fields from `data` keeps the two in lockstep.
      const flatFrom = (d.data['from'] ?? d.data['organizer'] ?? null) as unknown;
      const flatSubject = (d.data['subject'] ?? d.data['title'] ?? d.data['summary'] ?? d.data['fileName'] ?? null) as unknown;
      const flatBody = (d.data['body'] ?? d.data['snippet'] ?? d.data['description'] ?? d.data['excerpt'] ?? null) as unknown;
      await client.query(
        `INSERT INTO decisions (id, user_id, situation_type, raw_event, interpreted_situation, domain, urgency, metadata, source, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() - ($10 || ' minutes')::interval)
         ON CONFLICT (id) DO UPDATE SET
           raw_event = EXCLUDED.raw_event,
           interpreted_situation = EXCLUDED.interpreted_situation,
           urgency = EXCLUDED.urgency,
           created_at = EXCLUDED.created_at`,
        [
          d.id,
          userId,
          d.situationType,
          JSON.stringify({
            source: d.source,
            type: d.eventType,
            from: flatFrom,
            subject: flatSubject,
            body: flatBody,
            data: d.data,
          }),
          JSON.stringify({ summary: d.summary, type: d.situationType }),
          d.domain,
          d.urgency,
          JSON.stringify({ source: d.source, demo: true }),
          d.source,
          String(d.minutesAgo),
        ],
      );

      const sel = d.outcome.selectedAction;
      if (sel) {
        await client.query(
          `INSERT INTO candidate_actions (id, decision_id, action_type, description, parameters, predicted_user_preference, risk_assessment, reversible, estimated_cost)
           VALUES ($1, $2, $3, $4, $5, 'likely_approve', $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET
             description = EXCLUDED.description,
             parameters = EXCLUDED.parameters,
             risk_assessment = EXCLUDED.risk_assessment`,
          [
            sel.id,
            d.id,
            sel.type,
            sel.description,
            JSON.stringify(sel.parameters),
            // Must be a real RiskAssessment (overallTier + reasoning) — the
            // approve preflight parses this via parseRiskAssessmentFromRow and
            // 409s if overallTier is absent. A thin {level,factors} shape reads
            // as "no assessment on file" and blocks execution.
            JSON.stringify({
              actionId: sel.id,
              overallTier: d.outcome.requiresApproval ? 'moderate' : 'low',
              dimensions: {},
              reasoning: d.outcome.escalationReason ?? 'Routine, low-risk action matching your preferences.',
            }),
            sel.reversible,
            sel.estimatedCost,
          ],
        );
      }

      await client.query(
        `INSERT INTO decision_outcomes (id, decision_id, selected_action_id, auto_executed, requires_approval, escalation_reason, explanation, confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           auto_executed = EXCLUDED.auto_executed,
           requires_approval = EXCLUDED.requires_approval,
           escalation_reason = EXCLUDED.escalation_reason,
           explanation = EXCLUDED.explanation,
           confidence = EXCLUDED.confidence`,
        [
          d.outcomeId,
          d.id,
          sel?.id ?? null,
          d.outcome.autoExecuted,
          d.outcome.requiresApproval,
          d.outcome.escalationReason ?? null,
          d.outcome.explanation,
          d.outcome.confidence,
        ],
      );

      if (d.approval) {
        await client.query(
          `INSERT INTO approval_requests (id, user_id, decision_id, candidate_action, reason, urgency, status, requested_at, expires_at, confirmation_level)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending', now() - ($7 || ' minutes')::interval, now() + ($8 || ' days')::interval, $9)
           ON CONFLICT (id) DO UPDATE SET
             candidate_action = EXCLUDED.candidate_action,
             reason = EXCLUDED.reason,
             urgency = EXCLUDED.urgency,
             status = 'pending',
             responded_at = NULL,
             response = NULL,
             first_confirmed_at = NULL,
             requested_at = EXCLUDED.requested_at,
             expires_at = EXCLUDED.expires_at,
             confirmation_level = EXCLUDED.confirmation_level`,
          [
            d.approval.id,
            userId,
            d.id,
            // The approve preflight (approvals.ts) reads candidate_action.id and
            // looks up its risk_assessment in the candidate_actions table before
            // it will execute — a missing id means every "Yes, do it" 409s with
            // risk_assessment_missing. Link the embedded action to the seeded
            // candidate_actions row (sel.id), which carries a risk_assessment,
            // so the demo approvals actually run (via the mock executor).
            JSON.stringify({ id: sel?.id, ...d.approval.candidateAction }),
            d.approval.reason,
            d.approval.urgency,
            String(d.minutesAgo),
            String(d.approval.expiresInDays),
            d.approval.confirmationLevel ?? 'single',
          ],
        );
      }
    }
    console.log(`[seed] Created ${demoDecisions.length} recent demo decisions (with approvals + outcomes) for the sample profile.`);

    // A populated daily briefing so /briefing reads real prose immediately —
    // human-meaningful, to-dos vs FYIs, no internal jargon. generated_at = now()
    // and read_at = NULL so it shows the "New" badge. Structured to-dos/topics
    // are built live from the decisions above; this is the prose companion.
    const dailyBriefingProse = [
      '## Your daily briefing',
      '',
      'Here\'s where things stand. Three things need you; the rest I\'ve handled.',
      '',
      '### Needs you',
      '',
      '- **Reply to Dana at BrightPath** about the pilot start date and pricing — I drafted it, just review and send.',
      '- **Approve (or skip) the $79.99 Figma renewal** — it\'s over your $50 auto-approve limit, so it\'s your call.',
      '- **Confirm the $1,250 payment to Northwind Design** (invoice #2041, due July 7). New payee, so I\'ll ask you to confirm twice.',
      '',
      'Also worth a look: a Google security alert about a new sign-in from Lisbon, and an RSVP for Priya\'s Q3 Planning Offsite (due Friday).',
      '',
      '### Handled for you',
      '',
      '- Accepted your recurring daily Eng Standup',
      '- Archived a Daily Stoic newsletter',
      '- Categorized a $5.75 Blue Bottle coffee as Food & Drink',
      '- Filed Invoice-Northwind-2041.pdf into Finance/Invoices',
      '- Logged your 3.2 mile morning run',
      '',
      'Nothing else needs you right now.',
    ].join('\n');

    const weeklyBriefingProse = [
      '## Your week with your twin',
      '',
      'Over the last seven days I handled 34 things on my own and brought 6 to you.',
      '',
      '- **Calendar:** accepted 12 recurring meetings, declined 2 Friday-afternoon invites, protected your focus blocks.',
      '- **Inbox:** archived 18 newsletters and promotions, drafted 4 replies (you sent 3, edited 1).',
      '- **Money:** auto-categorized 9 small charges; escalated 2 over your $50 limit.',
      '- **You corrected me once** — you\'d rather I not auto-accept meetings that overlap lunch. Learned it; I\'ll ask next time.',
      '',
      'Trust is trending up: you\'ve approved 91% of what I proposed this week.',
    ].join('\n');

    await client.query(
      `INSERT INTO twin_briefings (id, user_id, cadence, generated_at, prose_markdown, source_event_count, llm_provider, llm_cost_cents, read_at)
       VALUES
         ('bf000001-0000-4000-8000-000000000001', $1, 'daily', now() - INTERVAL '15 minutes', $2, 10, 'embedded', 0, NULL),
         ('bf000002-0000-4000-8000-000000000002', $1, 'weekly', now() - INTERVAL '2 days', $3, 40, 'embedded', 0, NULL)
       ON CONFLICT (id) DO UPDATE SET
         generated_at = EXCLUDED.generated_at,
         prose_markdown = EXCLUDED.prose_markdown,
         source_event_count = EXCLUDED.source_event_count,
         read_at = NULL`,
      [userId, dailyBriefingProse, weeklyBriefingProse],
    );
    console.log('[seed] Created fresh daily + weekly briefings for the sample profile.');

    // Fill in every OTHER surface for the sample profile, plus rich Pat + Carol
    // personas (learnings, memory/search, capabilities, trust progress, chat
    // wiring). Kept in its own module so this file stays readable.
    await seedDemoShowcase(client);

    console.log('[seed] Seeding complete!');
  });
}

/**
 * CLI entry point.
 */
async function main(): Promise<void> {
  try {
    await seed();
  } catch (error) {
    console.error('[seed] Seeding failed:', error);
    process.exit(1);
  } finally {
    await closePool();
  }
}

main();
