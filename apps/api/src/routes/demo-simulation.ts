import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { SampleSimulationStateResponse } from '@skytwin/shared-types';
import {
  inspectDemoSession,
  isLocalDemoAddress,
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

function requireSampleSimulationSession(
  req: AuthenticatedSampleRequest,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader('Cache-Control', 'no-store');
  const ip = req.ip ?? req.socket.remoteAddress;
  if (!isLocalDemoAddress(ip)) {
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
): Router {
  const router = Router();
  router.use(requireSampleSimulationSession);

  router.get('/', async (req: AuthenticatedSampleRequest, res, next) => {
    try {
      const session = req.sampleSimulationSession!;
      const state: SampleSimulationStateResponse = await service.getState(
        session.sessionKey,
        session.expiresAtMs,
      );
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

  router.delete('/', (req: AuthenticatedSampleRequest, res) => {
    service.discard(req.sampleSimulationSession!.sessionKey);
    res.status(204).end();
  });

  return router;
}
