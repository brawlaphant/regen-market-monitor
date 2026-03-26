import "dotenv/config";
import { ThresholdTuner } from "./threshold-tuner.js";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const tuner = new ThresholdTuner(config, logger);

const report = tuner.analyze();
console.log(tuner.buildTuningReport(report));
process.exit(0);
