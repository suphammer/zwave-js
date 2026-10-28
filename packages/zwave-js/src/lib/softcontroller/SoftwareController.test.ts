/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import { expect, test } from "vitest";

import { normalizeInclusionChannel } from "./SoftwareController.js";

test("preserves an omitted inclusion channel for the 9.6 kbit/s default", () => {
	expect(normalizeInclusionChannel(undefined)).toBeUndefined();
});

test("accepts logical inclusion channels across the unsigned-byte range", () => {
	for (const channel of [0, 1, 2, 255]) {
		expect(normalizeInclusionChannel(channel)).toBe(channel);
	}
});

test("rejects invalid inclusion channel numbers before radio initialization", () => {
	for (const channel of [-1, 256, 0.5, NaN, Infinity, -Infinity]) {
		expect(() => normalizeInclusionChannel(channel)).toThrow(
			"inclusionChannel must be an unsigned byte",
		);
	}
});
