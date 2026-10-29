/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import { expect, test } from "vitest";

import {
	encodeControllerNodeProtocolInfo,
	encodeExclusionNodeId,
} from "./ControllerBackend.js";

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

test("preserves the foreign-exclusion unknown-node callback sentinel", () => {
	expect(encodeExclusionNodeId(0, 1)).toBe(0);
});

test("retains valid local exclusion IDs while rejecting the controller", () => {
	for (const nodeId of [2, 9, 232]) {
		expect(encodeExclusionNodeId(nodeId, 1)).toBe(nodeId);
	}
	expect(() => encodeExclusionNodeId(1, 1)).toThrow("own node ID");
});

test.each([-1, 233, 0xef, 0xff, 1.5, NaN, Infinity])(
	"rejects invalid excluded node ID %s",
	(nodeId) => {
		expect(() => encodeExclusionNodeId(nodeId, 1)).toThrow(
			"excluded node ID",
		);
	},
);
