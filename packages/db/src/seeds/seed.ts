import { getPool, closePool, withTransaction } from '../connection.js';

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
         'established',
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
        JSON.stringify([
          {
            domain: 'communication',
            key: 'response_style',
            value: 'concise',
            confidence: 'high',
          },
          {
            domain: 'scheduling',
            key: 'meeting_buffer',
            value: 15,
            confidence: 'medium',
          },
          {
            domain: 'shopping',
            key: 'brand_preference',
            value: { category: 'electronics', preferred: ['Apple', 'Sony'] },
            confidence: 'high',
          },
        ]),
        JSON.stringify([
          {
            type: 'behavioral',
            key: 'morning_person',
            value: true,
            confidence: 0.85,
            observedFrom: 'calendar_patterns',
          },
          {
            type: 'preference',
            key: 'prefers_async',
            value: true,
            confidence: 0.72,
            observedFrom: 'communication_history',
          },
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
      `INSERT INTO decisions (id, user_id, situation_type, raw_event, interpreted_situation, domain, urgency, metadata)
       VALUES (
         'f6a7b8c9-d0e1-4f2a-3b4c-5d6e7f809102',
         $1, 'meeting_request', $2, $3, 'scheduling', 'normal', $4
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
        `INSERT INTO explanation_records (id, decision_id, what_happened, evidence_used, preferences_invoked, confidence_reasoning, action_rationale, correction_guidance)
         VALUES (
           '31a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5f',
           $1,
           'Automatically accepted a recurring weekly sync meeting from a known colleague.',
           $2,
           $3,
           'High confidence (0.92) based on: recurring meeting pattern, known sender, no scheduling conflicts, and matching calendar management policy.',
           'The meeting matches the auto-accept policy for recurring meetings from known colleagues with no conflicts.',
           'If you prefer not to auto-accept this type of meeting, update the calendar management policy or lower the trust tier for scheduling actions.'
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
      `INSERT INTO decisions (id, user_id, situation_type, raw_event, interpreted_situation, domain, urgency, metadata)
       VALUES (
         'a7b8c9d0-e1f2-4a3b-4c5d-6e7f80910213',
         $1, 'purchase_suggestion', $2, $3, 'purchasing', 'low', $4
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
        `INSERT INTO approval_requests (id, user_id, decision_id, candidate_action, reason, urgency, status)
         VALUES (
           '71a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b63',
           $1, $2, $3,
           'Subscription renewal of $79.99 from NewService Inc. exceeds auto-approve limit and is from a new vendor.',
           'low', 'pending'
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
