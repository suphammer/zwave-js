/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import { expect, test } from "vitest";

import { canMatchAcknowledgementHomeId } from "./AcknowledgementHomeId.js";

const supported = { foreignHomeIdAcknowledgement: true };

test("normal traffic does not require the optional foreign ACK contract", () => {
	expect(canMatchAcknowledgementHomeId(undefined, {}, false, true)).toBe(
		true,
	);
});

test("foreign ACK matching is negotiated and applies only to direct acknowledged frames", () => {
	const homeId = 0x87654321;
	expect(canMatchAcknowledgementHomeId(homeId, supported, true, false)).toBe(
		true,
	);
	expect(canMatchAcknowledgementHomeId(homeId, {}, true, false)).toBe(false);
	expect(
		canMatchAcknowledgementHomeId(
			homeId,
			{ foreignHomeIdAcknowledgement: false },
			true,
			false,
		),
	).toBe(false);
	expect(canMatchAcknowledgementHomeId(homeId, supported, false, false)).toBe(
		false,
	);
	expect(canMatchAcknowledgementHomeId(homeId, supported, true, true)).toBe(
		false,
	);
});

test.each([0, -1, 0xffff_ffff, 0x1_0000_0000, 1.5, NaN, Infinity])(
	"rejects an invalid expected ACK Home ID %s before a radio operation",
	(homeId) => {
		expect(
			canMatchAcknowledgementHomeId(homeId, supported, true, false),
		).toBe(false);
	},
);
