/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import { ProtocolDataRate } from "@zwave-js/core";
import { expect, test } from "vitest";

import { shouldSetSpeedModified } from "./DataRate.js";

const radioRates = [
	ProtocolDataRate.ZWave_9k6,
	ProtocolDataRate.ZWave_40k,
	ProtocolDataRate.ZWave_100k,
];

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
