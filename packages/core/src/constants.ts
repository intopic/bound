import { address } from '@solana/kit';

export const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
export const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const COMPUTE_BUDGET_PROGRAM = address('ComputeBudget111111111111111111111111111111');
export const JUPITER_PROGRAM = address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');

/** Native SOL is always handled as wrapped SOL (WSOL) inside the protected transaction. */
export const WSOL_MINT = address('So11111111111111111111111111111111111111112');

export const LEGACY_SIZE_LIMIT = 1232;
export const V1_SIZE_LIMIT = 4096;
export const V1_MAX_ACCOUNTS = 64;
export const MAX_COMPUTE_UNITS = 1_400_000;
/**
 * Base fee per signature. A cluster parameter, not a constant of nature: if it ever changes, R4
 * would understate the fee. The pipeline also cross-checks with the RPC's getFeeForMessage (B-12).
 */
export const LAMPORTS_PER_SIGNATURE = 5000n;
export const TOKEN_ACCOUNT_SIZE = 165;
/**
 * A Token-2022 associated account: the base account, the account-type byte and an ImmutableOwner
 * extension header, which the ATA program always adds. Only its rent differs from a classic one.
 */
export const TOKEN_2022_ACCOUNT_SIZE = 170;
export const MINT_SIZE = 82;
/** Intermediate ATA(E, m) accounts a route may use (D14). Real routes use 0 to 2 (audit B-10). */
export const MAX_INTERMEDIATE_ACCOUNTS = 4;
export const BPS_DENOMINATOR = 10_000n;

// Ceilings the verifier enforces whatever the configuration says (audit B-01, B-02). The fee and
// F_max reach the browser from the deployment; these limits do not, so a compromised backend or a
// config bug cannot push past them.
export const MAX_FEE_BPS = 100n; // 1% ceiling; the current product fee is 0.2%
export const ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS = 1_000_000n; // 0.001 SOL
/**
 * The most W may send E for rent of an account the route opens in E's name. Both of Pump.fun's
 * markets open one per buyer (1,346,200 lamports in September 2026), and the bonding curve may add
 * 132,080 for growing the curve's own account. A route that needs more is refused; a route that
 * wants SOL to spend, not to rent with, cannot fit under it.
 */
export const MAX_TAKER_RENT_LAMPORTS = 5_000_000n; // 0.005 SOL
/**
 * The most tolerance a Jupiter route may carry on chain (review FA-03). Jupiter's program stops the
 * swap when this instruction delivers less than its quoted amount less this tolerance, whatever the
 * destination held before, so it is a floor independent of the RPC. The verifier reads it from the
 * instruction: 0.5%, or 3% when the route trades on a Pump.fun bonding curve.
 */
export const MAX_ROUTE_SLIPPAGE_BPS = 50;
export const MAX_CURVE_SLIPPAGE_BPS = 300;
/** Pump.fun's bonding-curve program: a route through it is priced on the curve. */
export const PUMP_CURVE_PROGRAM = address('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const MAX_LOADED_ACCOUNTS_DATA_SIZE = 64 * 1024 * 1024;

/**
 * Rent-exempt minimum of a 165-byte token account before the 2026 rent reduction (now 1,488,440).
 * Only an upper bound for display when the RPC cannot answer: the live value comes from
 * getMinimumBalanceForRentExemption (audit C-09).
 */
export const TOKEN_ACCOUNT_RENT_UPPER_BOUND_LAMPORTS = 2_039_280n;
