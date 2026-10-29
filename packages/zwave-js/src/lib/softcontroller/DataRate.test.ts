/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import { ProtocolDataRate } from "@zwave-js/core";
import { Bytes } from "@zwave-js/shared";
import { expect, test } from "vitest";

import {
	getInclusionVerificationChannels,
	shouldSetSpeedModified,
} from "./DataRate.js";
import { parseOverAirNodeInformationFrame } from "./NodeInformation.js";

const radioRates = [
	ProtocolDataRate.ZWave_9k6,
	ProtocolDataRate.ZWave_40k,
	ProtocolDataRate.ZWave_100k,
];

const euChannels = [
	{ channel: 0, dataRate: ProtocolDataRate.ZWave_100k },
	{ channel: 1, dataRate: ProtocolDataRate.ZWave_40k },
	{ channel: 2, dataRate: ProtocolDataRate.ZWave_9k6 },
];

test("Qubino's captured d39c01 NIF retains the observed 9.6 kbit/s PHY before trying advertised 40 kbit/s", () => {
	const nif = parseOverAirNodeInformationFrame(
		Bytes.from("d39c0110015e2527855986725a70327173987aef20", "hex"),
	);
	expect(
		getInclusionVerificationChannels(
			euChannels,
			nif.supportedDataRates,
			0,
			2,
		),
	).toEqual([0, 2, 1]);
});

test("Fibaro's captured d39c00 NIF enables its observed PHY without inventing 100 kbit/s support", () => {
	const nif = parseOverAirNodeInformationFrame(
		Bytes.from("d39c0010012527", "hex"),
	);
	expect(
		getInclusionVerificationChannels(
			euChannels,
			nif.supportedDataRates,
			1,
			2,
		),
	).toEqual([1, 2]);
});

test("orders the preferred and observed shared channels before remaining rates", () => {
	const channels = [
		{ channel: 9, dataRate: ProtocolDataRate.ZWave_40k },
		{ channel: 7, dataRate: ProtocolDataRate.ZWave_9k6 },
		{ channel: 2, dataRate: ProtocolDataRate.ZWave_100k },
	];
	expect(
		getInclusionVerificationChannels(
			channels,
			[9_600, 40_000, 100_000],
			2,
			7,
		),
	).toEqual([2, 7, 9]);
});

test("ignores an unshared preferred channel and deduplicates observed candidates", () => {
	expect(
		getInclusionVerificationChannels(
			euChannels,
			[40_000, 100_000, 100_000],
			2,
			1,
		),
	).toEqual([1, 0]);
	expect(
		getInclusionVerificationChannels(euChannels, [40_000], 1, 1),
	).toEqual([1]);
});

test("FLiRS verification retains the atomic beam contract on 40 kbit/s only", () => {
	expect(
		getInclusionVerificationChannels(
			euChannels,
			[9_600, 40_000, 100_000],
			0,
			2,
			true,
		),
	).toEqual([1]);
	expect(
		getInclusionVerificationChannels(euChannels, [100_000], 0, 0, true),
	).toEqual([]);
});

test("uses only advertised or actually observed Classic profiles and never confuses LR at 100 kbit/s", () => {
	expect(getInclusionVerificationChannels(euChannels, [], 0, 2)).toEqual([2]);
	expect(
		getInclusionVerificationChannels(euChannels.slice(2), [40_000], 2, 1),
	).toEqual([]);
	expect(
		getInclusionVerificationChannels(
			[{ channel: 0, dataRate: ProtocolDataRate.LongRange_100k }],
			[100_000],
			0,
			0,
		),
	).toEqual([]);
});

test("keeps distinct same-rate channels in deterministic table order", () => {
	const channels = [0, 1, 2].map((channel) => ({
		channel,
		dataRate: ProtocolDataRate.ZWave_100k,
	}));
	expect(getInclusionVerificationChannels(channels, [100_000], 1, 2)).toEqual(
		[1, 2, 0],
	);
});

test("marks 9.6 kbit/s Assign IDs for a peer whose NIF advertises 40 kbit/s", () => {
	expect(
		shouldSetSpeedModified(
			ProtocolDataRate.ZWave_9k6,
			radioRates,
			[40_000],
		),
	).toBe(true);
	expect(
		shouldSetSpeedModified(
			ProtocolDataRate.ZWave_40k,
			radioRates,
			[40_000],
		),
	).toBe(false);
});

test("marks lower direct rates when both endpoints support 100 kbit/s", () => {
	const peerBitRates = [9_600, 40_000, 100_000];
	for (const rate of [
		ProtocolDataRate.ZWave_9k6,
		ProtocolDataRate.ZWave_40k,
	]) {
		expect(shouldSetSpeedModified(rate, radioRates, peerBitRates)).toBe(
			true,
		);
	}
	expect(
		shouldSetSpeedModified(
			ProtocolDataRate.ZWave_100k,
			radioRates,
			peerBitRates,
		),
	).toBe(false);
});

test("uses the shared maximum instead of either endpoint's maximum alone", () => {
	expect(
		shouldSetSpeedModified(
			ProtocolDataRate.ZWave_40k,
			[ProtocolDataRate.ZWave_9k6, ProtocolDataRate.ZWave_40k],
			[9_600, 40_000, 100_000],
		),
	).toBe(false);
	expect(
		shouldSetSpeedModified(
			ProtocolDataRate.ZWave_40k,
			radioRates,
			[9_600, 40_000],
		),
	).toBe(false);
});

test("does not mark the only shared Classic rate or unknown capabilities", () => {
	expect(
		shouldSetSpeedModified(ProtocolDataRate.ZWave_9k6, radioRates, [9_600]),
	).toBe(false);
	expect(
		shouldSetSpeedModified(ProtocolDataRate.ZWave_9k6, radioRates, []),
	).toBe(false);
	expect(
		shouldSetSpeedModified(ProtocolDataRate.ZWave_9k6, [], [40_000]),
	).toBe(false);
});

test("does not infer a Classic reduction from Long Range rates", () => {
	expect(
		shouldSetSpeedModified(
			ProtocolDataRate.LongRange_100k,
			radioRates,
			[100_000],
		),
	).toBe(false);
	expect(
		shouldSetSpeedModified(
			ProtocolDataRate.ZWave_9k6,
			[ProtocolDataRate.LongRange_100k],
			[100_000],
		),
	).toBe(false);
});
