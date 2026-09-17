import { Router } from 'express';
import type { Request } from 'express';
import { bindUserIdParamOwnership } from '../middleware/require-ownership.js';
import {
  bindUserIdParamValidator,
  bindUuidParamValidator,
  isValidUserId,
} from '../middleware/validate-uuid.js';
import {
  adaptiveWorkflowService,
  type WorkflowTransitionResult,
} from '../lib/adaptive-workflow-service.js';

type AdaptiveWorkflowServicePort = Pick<
  typeof adaptiveWorkflowService,
  | 'readiness'
  | 'authorSignalDigestDraft'
  | 'createRevision'
  | 'reviseFromFeedback'
  | 'list'
  | 'detail'
  | 'versions'
  | 'resumableDraft'
  | 'activate'
  | 'rollbackWorkflowVersion'
>;

export interface AdaptiveWorkflowsRouterDependencies {
  service?: AdaptiveWorkflowServicePort;
}

function authoringFailureStatus(state: string): number {
  switch (state) {
    case 'policy_blocked': return 403;
    case 'setup_required':
    case 'confirmation_required':
    case 'artifact_unavailable': return 409;
    case 'clarification_required':
    case 'unsupported_model': return 422;
    case 'runtime_unavailable':
    case 'temporarily_unavailable': return 503;
    default: return 500;
  }
}

function transitionFailureStatus(result: Extract<WorkflowTransitionResult, { success: false }>): number {
  switch (result.reason) {
    case 'workflow_not_found':
    case 'version_not_found':
    case 'proposal_not_found': return 404;
    case 'active_version_conflict':
    case 'not_previously_active': return 409;
    case 'unsupported_provider':
    case 'invalid_version':
    case 'projection_mismatch': return 422;
  }
}

function invalidOptionalUuid(value: unknown): boolean {
  return value !== null && !isValidUserId(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function mutationIdempotencyKey(req: Request): string | null {
  const key = req.get('idempotency-key');
  return isValidUserId(key) ? key : null;
}

export function createAdaptiveWorkflowsRouter(
  dependencies: AdaptiveWorkflowsRouterDependencies = {},
): Router {
  const router = Router();
  const service = dependencies.service ?? adaptiveWorkflowService;

  bindUserIdParamValidator(router);
  bindUserIdParamOwnership(router);
  bindUuidParamValidator(router, 'workflowId', 'invalid_workflow_id', 'Workflow ID');

  router.get('/:userId/readiness', async (req, res, next) => {
    try {
      const readiness = await service.readiness(req.params['userId']!);
      res.status(readiness.state === 'ready' ? 200 : authoringFailureStatus(readiness.state)).json({ readiness });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:userId/signal-digest-drafts', async (req, res, next) => {
    try {
      const idempotencyKey = mutationIdempotencyKey(req);
      if (!idempotencyKey) {
        res.status(400).json({ error: 'Idempotency-Key must be a UUID' });
        return;
      }
      const body = req.body as { description?: unknown; allowClarification?: unknown } | undefined;
      const description = body?.description;
      if (typeof description !== 'string' || !description.trim()) {
        res.status(400).json({ error: 'description must be a non-empty string' });
        return;
      }
      if (body?.allowClarification !== undefined && typeof body.allowClarification !== 'boolean') {
        res.status(400).json({ error: 'allowClarification must be a boolean when provided' });
        return;
      }
      const result = await service.authorSignalDigestDraft({
        userId: req.params['userId']!,
        description,
        allowClarification: body?.allowClarification ?? true,
        idempotencyKey,
      });
      if (!result.success) {
        if (result.kind === 'authoring') {
          res.status(authoringFailureStatus(result.failure.state)).json(result);
        } else if (result.kind === 'compile') {
          res.status(422).json(result);
        } else if (result.kind === 'idempotency') {
          res.status(409).json(result);
        } else {
          res.status(500).json(result);
        }
        return;
      }
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:userId', async (req, res, next) => {
    try {
      res.json({ workflows: await service.list(req.params['userId']!) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:userId/resumable-draft', async (req, res, next) => {
    try {
      res.json({ candidate: await service.resumableDraft(req.params['userId']!) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:userId/:workflowId/versions', async (req, res, next) => {
    try {
      const versions = await service.versions(req.params['userId']!, req.params['workflowId']!);
      if (versions === null) {
        res.status(404).json({ error: 'workflow_not_found' });
        return;
      }
      res.json({ versions });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:userId/:workflowId/revisions', async (req, res, next) => {
    try {
      const idempotencyKey = mutationIdempotencyKey(req);
      if (!idempotencyKey) {
        res.status(400).json({ error: 'Idempotency-Key must be a UUID' });
        return;
      }
      if (!isPlainRecord(req.body)
          || !hasExactKeys(req.body, ['parentVersionId', 'payload'])
          || !isValidUserId(req.body['parentVersionId'])
          || !isPlainRecord(req.body['payload'])) {
        res.status(400).json({
          error: 'body must contain exactly a parentVersionId UUID and structured payload object',
        });
        return;
      }
      const result = await service.createRevision({
        userId: req.params['userId']!,
        workflowId: req.params['workflowId']!,
        parentVersionId: req.body['parentVersionId'],
        payload: req.body['payload'],
        idempotencyKey,
      });
      if (!result.success) {
        if (result.kind === 'transition') {
          res.status(transitionFailureStatus(result.failure)).json(result);
        } else if (result.kind === 'compile') {
          res.status(422).json(result);
        } else if (result.kind === 'create_version') {
          res.status(
            result.reason === 'active_version_conflict'
              || result.reason === 'idempotency_conflict' ? 409 : 404,
          ).json(result);
        } else {
          res.status(500).json(result);
        }
        return;
      }
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:userId/:workflowId/feedback-revisions', async (req, res, next) => {
    try {
      const idempotencyKey = mutationIdempotencyKey(req);
      if (!idempotencyKey) {
        res.status(400).json({ error: 'Idempotency-Key must be a UUID' });
        return;
      }
      if (!isPlainRecord(req.body)
          || !hasExactKeys(req.body, ['parentVersionId', 'feedback'])
          || !isValidUserId(req.body['parentVersionId'])
          || typeof req.body['feedback'] !== 'string'
          || !req.body['feedback'].trim()) {
        res.status(400).json({
          error: 'body must contain exactly a parentVersionId UUID and non-empty feedback string',
        });
        return;
      }
      const result = await service.reviseFromFeedback({
        userId: req.params['userId']!,
        workflowId: req.params['workflowId']!,
        parentVersionId: req.body['parentVersionId'],
        feedback: req.body['feedback'],
        idempotencyKey,
      });
      if (!result.success) {
        if (result.kind === 'authoring') {
          res.status(authoringFailureStatus(result.failure.state)).json(result);
        } else if (result.kind === 'transition') {
          res.status(transitionFailureStatus(result.failure)).json(result);
        } else if (result.kind === 'compile') {
          res.status(422).json(result);
        } else if (result.kind === 'create_version') {
          res.status(
            result.reason === 'active_version_conflict'
              || result.reason === 'idempotency_conflict' ? 409 : 404,
          ).json(result);
        } else {
          res.status(500).json(result);
        }
        return;
      }
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:userId/:workflowId', async (req, res, next) => {
    try {
      const detail = await service.detail(req.params['userId']!, req.params['workflowId']!);
      if (detail === null) {
        res.status(404).json({ error: 'workflow_not_found' });
        return;
      }
      res.json(detail);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:userId/:workflowId/activate', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!isValidUserId(body['versionId']) || !isValidUserId(body['proposalId'])
          || invalidOptionalUuid(body['expectedActiveVersionId'])) {
        res.status(400).json({
          error: 'versionId and proposalId must be UUIDs; expectedActiveVersionId must be a UUID or null',
        });
        return;
      }
      const result = await service.activate({
        userId: req.params['userId']!,
        workflowId: req.params['workflowId']!,
        versionId: body['versionId'],
        proposalId: body['proposalId'],
        expectedActiveVersionId: body['expectedActiveVersionId'] as string | null,
      });
      if (!result.success) {
        res.status(transitionFailureStatus(result)).json(result);
        return;
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/:userId/:workflowId/rollback', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!isValidUserId(body['versionId']) || !isValidUserId(body['expectedActiveVersionId'])) {
        res.status(400).json({ error: 'versionId and expectedActiveVersionId must be UUIDs' });
        return;
      }
      const result = await service.rollbackWorkflowVersion({
        userId: req.params['userId']!,
        workflowId: req.params['workflowId']!,
        versionId: body['versionId'],
        expectedActiveVersionId: body['expectedActiveVersionId'],
      });
      if (!result.success) {
        res.status(transitionFailureStatus(result)).json(result);
        return;
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
