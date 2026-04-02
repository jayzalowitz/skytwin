/**
 * Expected Calibration Error (ECE) metric.
 *
 * Measures how well-calibrated the system's confidence scores are.
 * A well-calibrated system that says it's 80% confident should be
 * correct ~80% of the time.
 */
export interface CalibrationBin {
  binIndex: number;
  rangeStart: number;
  rangeEnd: number;
  avgConfidence: number;
  avgAccuracy: number;
  count: number;
  gap: number;
}

export interface CalibrationResult {
  ece: number;
  maxCalibrationError: number;
  bins: CalibrationBin[];
  totalSamples: number;
}

export interface ConfidenceSample {
  predictedConfidence: number;
  wasCorrect: boolean;
}

/**
 * Expected Calibration Error calculator.
 *
 * Bins predictions by confidence level and compares average confidence
 * to actual accuracy in each bin. ECE is the weighted average of the
 * gap across all bins.
 */
export class CalibrationErrorTracker {
  private samples: ConfidenceSample[] = [];

  record(sample: ConfidenceSample): void {
    this.samples.push({ ...sample });
  }

  calculate(numBins: number = 10): CalibrationResult {
    if (this.samples.length === 0) {
      return {
        ece: 0,
        maxCalibrationError: 0,
        bins: [],
        totalSamples: 0,
      };
    }

    const binWidth = 1 / numBins;
    const bins: CalibrationBin[] = [];

    for (let i = 0; i < numBins; i++) {
      const rangeStart = i * binWidth;
      const rangeEnd = (i + 1) * binWidth;

      const inBin = this.samples.filter(
        s => s.predictedConfidence >= rangeStart && s.predictedConfidence < rangeEnd,
      );

      if (inBin.length === 0) {
        bins.push({
          binIndex: i,
          rangeStart,
          rangeEnd,
          avgConfidence: 0,
          avgAccuracy: 0,
          count: 0,
          gap: 0,
        });
        continue;
      }

      const avgConfidence = inBin.reduce((s, x) => s + x.predictedConfidence, 0) / inBin.length;
      const avgAccuracy = inBin.filter(x => x.wasCorrect).length / inBin.length;
      const gap = Math.abs(avgAccuracy - avgConfidence);

      bins.push({
        binIndex: i,
        rangeStart,
        rangeEnd,
        avgConfidence,
        avgAccuracy,
        count: inBin.length,
        gap,
      });
    }

    // ECE = weighted average of gaps
    const total = this.samples.length;
    const ece = bins.reduce((sum, bin) => sum + (bin.count / total) * bin.gap, 0);
    const maxCalibrationError = Math.max(...bins.filter(b => b.count > 0).map(b => b.gap), 0);

    return {
      ece,
      maxCalibrationError,
      bins,
      totalSamples: total,
    };
  }
}
