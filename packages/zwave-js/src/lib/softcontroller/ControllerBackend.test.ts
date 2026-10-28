/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import { expect, test } from "vitest";

import { encodeControllerNodeProtocolInfo } from "./ControllerBackend.js";

test("unknown protocol info does not invent capabilities or device classes", () => {
	expect(encodeControllerNodeProtocolInfo(undefined)).toEqual(
		new Uint8Array(6),
	);
});

test("observed protocol info is preserved without sharing mutable storage", () => {
	const observed = Uint8Array.of(0x53, 0xa0, 0x01, 0x04, 0x20, 0x01);
	const encoded = encodeControllerNodeProtocolInfo(observed);
	expect(encoded).toEqual(observed);
	expect(encoded).not.toBe(observed);
	observed.fill(0);
	expect(encoded).toEqual(Uint8Array.of(0x53, 0xa0, 0x01, 0x04, 0x20, 0x01));
});

test.each([0, 1, 3, 5, 7])(
	"rejects a protocol info observation containing %i bytes",
	(length) => {
		expect(() =>
			encodeControllerNodeProtocolInfo(new Uint8Array(length)),
		).toThrow("exactly six bytes");
	},
);
