// Seeded, position-independent randomness (F40 FR-15).
//
// The requirement that shapes this file is not "random numbers" but "the same
// random numbers, everywhere, forever". Two properties follow, and both are
// easy to lose with an ordinary generator:
//
//   Adding an op elsewhere in the graph must not change an existing op's
//   sequence. That rules out one generator advanced across the whole
//   evaluation, because then every draw depends on how many draws happened
//   before it, and inserting an unrelated op upstream reshuffles everything
//   downstream. Instead each stream is seeded from its own coordinates:
//   (graph seed, op id, instance index, channel). Nothing else can perturb it.
//
//   Re-ordering unrelated branches must not perturb it either, which the same
//   construction gives for free: a stream's identity has no notion of "when"
//   it ran.
//
// splitmix64 is the generator because it is a handful of constants and shifts,
// needs no state beyond one 64-bit word, and is reproducible in Go in about
// eight lines. BigInt keeps the 64-bit arithmetic exact; `number` would lose
// the low bits above 2^53 and quietly diverge from the Go mirror.

import { hashString } from "./canonical";

const MASK64 = 0xffffffffffffffffn;
const GOLDEN = 0x9e3779b97f4a7c15n;

/** A deterministic stream of numbers. Cheap to create; create one per site. */
export interface Rng {
  /** Next raw 64-bit value. */
  nextU64(): bigint;
  /** Next float in [0, 1). */
  next(): number;
  /** Next integer in [minInclusive, maxExclusive). */
  nextInt(minInclusive: number, maxExclusive: number): number;
}

function splitmix64(state: bigint): { value: bigint; state: bigint } {
  let s = (state + GOLDEN) & MASK64;
  let z = s;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  z = z ^ (z >> 31n);
  return { value: z, state: s };
}

/**
 * A stream identified by where it is, not by when it runs.
 *
 * `channel` separates independent uses within one op (a scatter op wanting
 * position and rotation draws two channels rather than interleaving one
 * stream, so adding a rotation later does not move every position).
 */
export function rngFor(graphSeed: number, opId: string, instanceIndex = 0, channel = "default"): Rng {
  // Hash the coordinates rather than mixing them arithmetically: op ids are
  // strings, and a hash gives good dispersion for adjacent instance indices
  // without the caller having to think about it.
  const seedHex = hashString(`${graphSeed}${opId}${instanceIndex}${channel}`);
  let state = BigInt("0x" + seedHex) & MASK64;

  const nextU64 = (): bigint => {
    const r = splitmix64(state);
    state = r.state;
    return r.value;
  };

  return {
    nextU64,
    // 53 bits is what a double can hold exactly, so take the top 53 and divide.
    next: () => Number(nextU64() >> 11n) / 9007199254740992,
    nextInt: (minInclusive: number, maxExclusive: number) => {
      if (!(maxExclusive > minInclusive)) return minInclusive;
      const span = maxExclusive - minInclusive;
      return minInclusive + Math.floor((Number(nextU64() >> 11n) / 9007199254740992) * span);
    },
  };
}
