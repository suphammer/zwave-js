/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import { ProtocolDataRate } from "@zwave-js/core";

const classicBitRates = new Map<ProtocolDataRate, number>([
	[ProtocolDataRate.ZWave_9k6, 9_600],
	[ProtocolDataRate.ZWave_40k, 40_000],
	[ProtocolDataRate.ZWave_100k, 100_000],
]);

/** G.9959 §8.1.3.3.4 marks a direct transmission below the shared maximum. */
export function shouldSetSpeedModified(
	transmitRate: ProtocolDataRate,
	radioRates: readonly ProtocolDataRate[],
	peerBitRates: readonly number[],
): boolean {
	const transmitBitRate = classicBitRates.get(transmitRate);
	if (transmitBitRate === undefined) return false;
	return radioRates.some((rate) => {
		const bitRate = classicBitRates.get(rate);
		return (
			bitRate !== undefined
			&& bitRate > transmitBitRate
			&& peerBitRates.includes(bitRate)
		);
	});
}
