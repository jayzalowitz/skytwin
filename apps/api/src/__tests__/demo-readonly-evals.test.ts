import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Express } from "express";

const mockTwinService = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getOrCreateProfile: vi.fn(),
  getPatterns: vi.fn().mockResolvedValue([]),
  getTraits: vi.fn().mockResolvedValue([]),
  getTemporalProfile: vi.fn().mockResolvedValue({}),
}));

vi.mock("@skytwin/db", () => ({
  TwinRepositoryAdapter: vi.fn(),
  PatternRepositoryAdapter: vi.fn(),
  feedbackRepository: { findByUser: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@skytwin/twin-model", () => ({
  TwinService: vi.fn(function TwinService() {
    return mockTwinService;
  }),
}));

vi.mock("../middleware/require-ownership.js", () => ({
  bindUserIdParamOwnership: vi.fn(),
}));

import { createEvalsRouter } from "../routes/evals.js";

const USER_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

function buildDemoApp(): Express {
  const app = express();
  app.use((req, _res, next) => {
    req.demoAuthenticated = true;
    next();
  });
  app.use("/api/evals", createEvalsRouter());
  return app;
}

async function getStatus(app: Express, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine port"));
        return;
      }
      fetch(`http://127.0.0.1:${address.port}${path}`)
        .then((response) => {
          server.close();
          resolve(response.status);
        })
        .catch((error) => {
          server.close();
          reject(error);
        });
    });
  });
}

describe("demo eval reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTwinService.getProfile.mockResolvedValue(null);
    mockTwinService.getPatterns.mockResolvedValue([]);
    mockTwinService.getTraits.mockResolvedValue([]);
    mockTwinService.getTemporalProfile.mockResolvedValue({});
  });

  it("does not create a profile for learning or confidence GETs", async () => {
    for (const suffix of ["learning", "confidence"]) {
      await expect(
        getStatus(buildDemoApp(), `/api/evals/${USER_ID}/${suffix}`),
      ).resolves.toBe(404);
    }
    expect(mockTwinService.getProfile).toHaveBeenCalledTimes(2);
    expect(mockTwinService.getOrCreateProfile).not.toHaveBeenCalled();
  });
});
