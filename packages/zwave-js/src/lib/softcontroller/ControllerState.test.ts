/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import { expect, test } from "vitest";

import {
	type ControllerState,
	RANDOM_HOME_ID_MAX,
	RANDOM_HOME_ID_MIN,
	generateRandomHomeId,
	parseControllerState,
	serializeControllerState,
} from "./ControllerState.js";

function state(): ControllerState {
	return {
		includedNodeIds: [9, 1, 9, 4],
		quarantinedNodeIds: [7, 2],
		nodeChannels: new Map([
			[9, 1],
			[4, 2],
		]),
		nodeNeighbors: new Map([
			[1, [4]],
			[4, [1, 9]],
		]),
		repeaterNodeIds: new Set([4]),
		routes: new Map([[9, [4]]]),
		nodeProtocolInfo: new Map([
			[4, Uint8Array.of(0xdb, 0x98, 0x01, 0x04, 0x10, 0x01)],
			[9, Uint8Array.of(0x53, 0xa0, 0x01, 0x04, 0x20, 0x01)],
		]),
	};
}

test("normalizes one complete controller state without changing its input", () => {
	const input = state();
	const encoded = serializeControllerState(0x1122_3344, 1, input);
	const decoded = parseControllerState(encoded);
	expect(decoded.homeId).toBe(0x1122_3344);
	expect(decoded.ownNodeId).toBe(1);
	expect(decoded.includedNodeIds).toEqual([1, 4, 9]);
	expect(decoded.quarantinedNodeIds).toEqual([2, 7]);
	expect([...decoded.nodeChannels]).toEqual([
		[4, 2],
		[9, 1],
	]);
	expect([...decoded.nodeNeighbors]).toEqual([
		[1, [4]],
		[4, [1, 9]],
	]);
	expect([...decoded.repeaterNodeIds]).toEqual([4]);
	expect([...decoded.routes]).toEqual([[9, [4]]]);
	expect([...decoded.nodeProtocolInfo.keys()]).toEqual([4, 9]);
	expect(input.includedNodeIds).toEqual([9, 1, 9, 4]);
	expect(JSON.parse(encoded).version).toBe(5);
});

test.each([
	["homeId", -1],
	["homeId", 0],
	["homeId", 0xffff_ffff],
	["ownNodeId", 0],
	["includedNodeIds", [1, 233]],
	["quarantinedNodeIds", [4]],
	["quarantinedNodeIds", [2, 2]],
	["nodeChannels", { "04": 1 }],
	["nodeChannels", { "4": 256 }],
	["nodeNeighbors", { "1": [1] }],
	["repeaterNodeIds", [4, 4]],
	["routes", { "9": [9] }],
	["routes", { "9": [4, 4] }],
	["nodeProtocolInfo", { "4": [0, 1, 2] }],
])("rejects malformed persisted %s", (property, value) => {
	const encoded = JSON.parse(
		serializeControllerState(0x1122_3344, 1, state()),
	);
	encoded[property] = value;
	expect(() => parseControllerState(JSON.stringify(encoded))).toThrow(
		"Invalid software controller state",
	);
});

test.each([1, 2, 3, 4, 0, 6, undefined])(
	"rejects unsupported persisted state version %s",
	(version) => {
		const encoded = JSON.parse(
			serializeControllerState(0x1122_3344, 1, state()),
		);
		encoded.version = version;
		expect(() => parseControllerState(JSON.stringify(encoded))).toThrow(
			"Invalid software controller state",
		);
	},
);

test.each([
	"homeId",
	"ownNodeId",
	"includedNodeIds",
	"quarantinedNodeIds",
	"nodeChannels",
	"nodeNeighbors",
	"repeaterNodeIds",
	"routes",
	"nodeProtocolInfo",
])("requires persisted %s in a complete current revision", (property) => {
	const encoded = JSON.parse(
		serializeControllerState(0x1122_3344, 1, state()),
	);
	delete encoded[property];
	expect(() => parseControllerState(JSON.stringify(encoded))).toThrow(
		"Invalid software controller state",
	);
});

test("rejects quarantine overlap before writing state", () => {
	expect(() =>
		serializeControllerState(0x1122_3344, 1, {
			...state(),
			quarantinedNodeIds: [4],
		}),
	).toThrow("invalid quarantined node ID");
});

test.each([0, 0xffff_ffff])(
	"rejects reserved Home ID %i before persisting a state revision",
	(homeId) => {
		expect(() => serializeControllerState(homeId, 1, state())).toThrow(
			"valid 32-bit network Home ID",
		);
	},
);

test("generates Home IDs inside the Classic controller random range", () => {
	for (let index = 0; index < 32; index++) {
		const homeId = generateRandomHomeId();
		expect(Number.isInteger(homeId)).toBe(true);
		expect(homeId).toBeGreaterThanOrEqual(RANDOM_HOME_ID_MIN);
		expect(homeId).toBeLessThanOrEqual(RANDOM_HOME_ID_MAX);
	}
});
