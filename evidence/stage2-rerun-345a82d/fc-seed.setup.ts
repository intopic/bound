// Fixes and records fast-check's seed for every property in the run.
// BOUND_FC_SEED picks the seed; each property's own numRuns still applies.
import fc from 'fast-check';
const seed = Number(process.env.BOUND_FC_SEED ?? Date.now() % 2 ** 31);
fc.configureGlobal({ ...fc.readConfigureGlobal(), seed, verbose: 1 });
console.log(`[fc-seed] ${seed}`);
