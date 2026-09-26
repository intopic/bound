/**
 * Holds the hand-kept declarations (types/index.d.ts) to the source: `npm run typecheck` fails when
 * one of them says something the code does not.
 */
import type * as Src from '../src/index.ts';
import type * as Dts from '../types/index.d.ts';

// Exact equality: mutual assignability would miss an optional field present on one side only.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

export const sameTypes: [
  Same<Src.OrientimPluginOptions, Dts.OrientimPluginOptions>,
  Same<Src.OrientimSwapInput, Dts.OrientimSwapInput>,
  Same<Src.OrientimSwapResult, Dts.OrientimSwapResult>,
  Same<Src.OrientimPlugin, Dts.OrientimPlugin>,
  Same<typeof Src.createOrientimPlugin, typeof Dts.createOrientimPlugin>,
  Same<typeof Src.toBaseUnits, typeof Dts.toBaseUnits>,
  Same<typeof Src.fromBaseUnits, typeof Dts.fromBaseUnits>,
  Same<typeof Src.walletSigner, typeof Dts.walletSigner>,
  Same<typeof Src.protectedSwapAction, typeof Dts.protectedSwapAction>,
  Same<typeof Src.swapSchema, typeof Dts.swapSchema>,
  Same<typeof Src.SOL_MINT, typeof Dts.SOL_MINT>,
  Same<typeof Src.default, typeof Dts.default>,
  Same<Src.OrientimPluginError, Dts.OrientimPluginError>,
  Same<Src.PendingStore, Dts.PendingStore>,
  Same<Src.OrderBook, Dts.OrderBook>,
  Same<Src.Signed, Dts.Signed>,
  Same<Src.OrderRecord, Dts.OrderRecord>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
