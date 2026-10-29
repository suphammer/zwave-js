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

/** Recovery probes require a strictly faster, advertised shared Classic rate. */
export function getHigherDataRateChannels(
	channels: readonly { channel: number; dataRate: ProtocolDataRate }[],
	peerBitRates: readonly number[],
	currentChannel: number,
): number[] {
	const current = channels.find(({ channel }) => channel === currentChannel);
	const currentBitRate = current && classicBitRates.get(current.dataRate);
	if (currentBitRate === undefined) return [];
	const seenChannels = new Set<number>();
	return channels
		.toSorted(
			(left, right) =>
				(classicBitRates.get(right.dataRate) ?? 0)
				- (classicBitRates.get(left.dataRate) ?? 0),
		)
		.filter(({ channel, dataRate }) => {
			const bitRate = classicBitRates.get(dataRate);
			if (
				bitRate === undefined
				|| bitRate <= currentBitRate
				|| !peerBitRates.includes(bitRate)
				|| seenChannels.has(channel)
			)
				return false;
			seenChannels.add(channel);
			return true;
		})
		.map(({ channel }) => channel);
}

/** NOP verification may safely try another shared PHY after a missing ACK. */
export function getInclusionVerificationChannels(
	channels: readonly { channel: number; dataRate: ProtocolDataRate }[],
	peerBitRates: readonly number[],
	preferredChannel: number,
	receiveChannel: number,
	requiresBeam = false,
): number[] {
	const common = channels.filter(({ channel, dataRate }) => {
		const bitRate = classicBitRates.get(dataRate);
		return (
			bitRate !== undefined
			// A received NIF proves its PHY even when a legacy node omits that rate bit.
			&& (peerBitRates.includes(bitRate) || channel === receiveChannel)
			&& (!requiresBeam || dataRate === ProtocolDataRate.ZWave_40k)
		);
	});
	const remaining = common.toSorted(
		(left, right) =>
			classicBitRates.get(right.dataRate)!
			- classicBitRates.get(left.dataRate)!,
	);
	return [
		...new Set(
			[
				preferredChannel,
				receiveChannel,
				...remaining.map(({ channel }) => channel),
			].filter((channel) =>
				common.some((candidate) => candidate.channel === channel),
			),
		),
	];
}

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
