import type { ActionHandler, ExecutionStep, StepResult } from '@skytwin/shared-types';

/**
 * Handler for finance-related actions.
 *
 * Local operations (categorize, record, budget alerts, flagging) are handled
 * directly. Real financial operations (pay_bill, transfer_funds) throw to
 * trigger fallback to OpenClaw/Ollama which can integrate with external
 * payment services.
 */
export class FinanceActionHandler implements ActionHandler {
  readonly actionType = 'finance';
  readonly domain = 'finance';

  canHandle(actionType: string): boolean {
    return [
      'pay_bill',
      'categorize_transaction',
      'flag_suspicious_transaction',
      'record_expense',
      'transfer_funds',
      'set_budget_alert',
    ].includes(actionType);
  }

  async execute(step: ExecutionStep): Promise<StepResult> {
    const actionType = (step.parameters['actionType'] as string) ?? step.type;

    switch (actionType) {
      case 'pay_bill':
        throw new Error(
          'Financial operation requires external service integration — falling back to OpenClaw',
        );

      case 'transfer_funds':
        throw new Error(
          'Financial operation requires external service integration — falling back to OpenClaw',
        );

      case 'categorize_transaction':
        return {
          success: true,
          output: {
            action: 'transaction_categorized',
            transactionId: step.parameters['transactionId'] ?? 'unknown',
            category: step.parameters['category'] ?? 'uncategorized',
            details: 'Transaction categorized successfully.',
          },
        };

      case 'record_expense':
        return {
          success: true,
          output: {
            action: 'expense_recorded',
            amount: step.parameters['amount'] ?? 0,
            category: step.parameters['category'] ?? 'general',
            description: step.parameters['description'] ?? '',
            details: 'Expense recorded successfully.',
          },
        };

      case 'set_budget_alert':
        return {
          success: true,
          output: {
            action: 'budget_alert_set',
            category: step.parameters['category'] ?? 'general',
            threshold: step.parameters['threshold'] ?? 0,
            details: 'Budget alert configured successfully.',
          },
        };

      case 'flag_suspicious_transaction':
        return {
          success: true,
          output: {
            action: 'transaction_flagged',
            transactionId: step.parameters['transactionId'] ?? 'unknown',
            reason: step.parameters['reason'] ?? 'manual review',
            details: 'Transaction flagged for review.',
          },
        };

      default:
        return { success: false, error: `Unknown finance action: ${actionType}` };
    }
  }

  async rollback(step: ExecutionStep): Promise<StepResult> {
    const originalAction = (step.parameters['originalActionType'] as string) ?? step.type;

    switch (originalAction) {
      case 'categorize_transaction':
        return {
          success: true,
          output: { action: 'category_reverted', transactionId: step.parameters['transactionId'] },
        };
      case 'record_expense':
        return {
          success: true,
          output: { action: 'expense_removed', details: 'Recorded expense has been removed.' },
        };
      case 'set_budget_alert':
        return {
          success: true,
          output: { action: 'budget_alert_removed', details: 'Budget alert has been removed.' },
        };
      case 'flag_suspicious_transaction':
        return {
          success: true,
          output: { action: 'flag_removed', transactionId: step.parameters['transactionId'] },
        };
      default:
        return { success: false, error: `Cannot rollback finance action: ${originalAction}` };
    }
  }
}
