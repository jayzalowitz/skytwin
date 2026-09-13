import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { SampleSimulationStateResponse } from '@skytwin/shared-types';
import {
  inspectDemoSession,
  inspectDemoSessionForDiscard,
  isLocalDemoRequest,
} from '../auth/demo-session.js';
import {
  parseSampleSimulationCommand,
  SampleSimulationCommandError,
  SampleSimulationService,
} from '../services/sample-simulation.js';

interface AuthenticatedSampleRequest extends Request {
  sampleSimulationSession?: {
    sessionKey: string;
    expiresAtMs: number;
  };
}

type SampleAvailabilityCheck = () => Promise<boolean>;

function requireSampleSimulationSession(
  req: AuthenticatedSampleRequest,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader('Cache-Control', 'no-store');
  if (!isLocalDemoRequest(req.ip, req.socket.remoteAddress)) {
    res.status(403).json({
      error: 'The packaged sample is available from this device only.',
    });
    return;
  }
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const session = token ? inspectDemoSession(token) : null;
  if (!session) {
    res.status(401).json({
      error: 'Sample session expired',
      message: 'Restart the sample to continue.',
    });
    return;
  }
  req.sampleSimulationSession = session;
  next();
}

/**
 * Dedicated command surface for the fictional, session-local sample loop.
 *
 * This router does not mount normal sessionAuth: a sample credential remains
 * read-only everywhere else. Exact handlers below accept only the typed fixed
 * catalog commands and terminate inside SampleSimulationService.
 */
export function createDemoSimulationRouter(
  service = new SampleSimulationService(),
  isSampleAvailable: SampleAvailabilityCheck = async () => true,
): Router {
  const router = Router();

  async function requireAvailableFixture(
    req: AuthenticatedSampleRequest,
    res: Response,
  ): Promise<boolean> {
    if (await isSampleAvailable()) return true;
    const sessionKey = req.sampleSimulationSession?.sessionKey;
    if (sessionKey) service.discard(sessionKey);
    res.status(401).json({ error: 'Sample session is no longer available.' });
    return false;
  }

  // Deletion is the one operation that accepts an authentically signed but
  // expired sample token: it can only remove the state keyed by that token.
  router.delete('/', async (req: AuthenticatedSampleRequest, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!isLocalDemoRequest(req.ip, req.socket.remoteAddress)) {
      res.status(403).json({
        error: 'The packaged sample is available from this device only.',
      });
      return;
    }
    try {
      const header = req.headers.authorization;
      const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
      const session = token ? inspectDemoSessionForDiscard(token) : null;
      if (!session) {
        res.status(401).json({ error: 'Invalid sample session' });
        return;
      }
      service.discard(session.sessionKey);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.use(requireSampleSimulationSession);
  router.use(async (req: AuthenticatedSampleRequest, res, next) => {
    try {
      if (!(await requireAvailableFixture(req, res))) return;
      next();
    } catch (error) {
      next(error);
    }
  });
  router.get('/', async (req: AuthenticatedSampleRequest, res, next) => {
    try {
      const session = req.sampleSimulationSession!;
      const state: SampleSimulationStateResponse = await service.getState(
        session.sessionKey,
        session.expiresAtMs,
      );
      if (!(await requireAvailableFixture(req, res))) return;
      res.json(state);
    } catch (error) {
      if (error instanceof SampleSimulationCommandError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  router.post(
    '/commands',
    async (req: AuthenticatedSampleRequest, res, next) => {
      try {
        const command = parseSampleSimulationCommand(req.body);
        const session = req.sampleSimulationSession!;
        const state: SampleSimulationStateResponse = await service.command(
          session.sessionKey,
          session.expiresAtMs,
          command,
        );
        if (!(await requireAvailableFixture(req, res))) return;
        res.json(state);
      } catch (error) {
        if (error instanceof SampleSimulationCommandError) {
          res.status(error.statusCode).json({ error: error.message });
          return;
        }
        next(error);
      }
    },
  );

  return router;
}
