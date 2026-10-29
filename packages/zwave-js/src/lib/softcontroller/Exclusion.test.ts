/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import {
	AckZWaveMPDU,
	ExplorerFrameCommand,
	MPDU,
	MPDUHeaderType,
	NormalExplorerZWaveMPDU,
	ProtocolDataRate,
	RFRegion,
	RoutedZWaveMPDU,
	SinglecastZWaveMPDU,
	type SinglecastZWaveMPDUOptions,
} from "@zwave-js/core";
import { Bytes } from "@zwave-js/shared";
import { expect, test } from "vitest";

import { getExclusionTarget } from "./Exclusion.js";

const controller = { homeId: 0x12345678, ownNodeId: 1 };
const nifOptions = {
	homeId: 0x87654321,
	sourceNodeId: 9,
	destinationNodeId: 0xff,
	ackRequested: false,
	sequenceNumber: 3,
	speedModified: false,
	payload: Bytes.from([0x01, 0x01, 0xd3, 0x9c, 0x01, 0x10, 0x01, 0x5e, 0x98]),
};

function nif(overrides: Partial<SinglecastZWaveMPDUOptions> = {}) {
	return new SinglecastZWaveMPDU({ ...nifOptions, ...overrides });
}

test.each([
	{
		region: RFRegion.Europe,
		channel: 2,
		protocolDataRate: ProtocolDataRate.ZWave_9k6,
	},
	{
		region: RFRegion.Europe,
		channel: 1,
		protocolDataRate: ProtocolDataRate.ZWave_40k,
	},
	{
		region: RFRegion.Europe,
		channel: 0,
		protocolDataRate: ProtocolDataRate.ZWave_100k,
	},
	{
		region: RFRegion.Japan,
		channel: 0,
		protocolDataRate: ProtocolDataRate.ZWave_100k,
	},
])(
	"recognizes a foreign direct NIF in region $region at $protocolDataRate",
	(ctx) => {
		const frame = MPDU.parse(nif().serialize(ctx), ctx);
		const target = getExclusionTarget(frame, controller);

		expect(target?.nodeId).toBe(9);
		expect(target?.callbackNodeId).toBe(0);
		expect(target?.acknowledgementHomeId).toBe(nifOptions.homeId);
		expect(target?.nodeInformation.genericDeviceClass).toBe(0x10);
		expect(target?.nodeInformation.supportedCCs).toEqual([0x5e, 0x98]);
	},
);

test("a foreign numeric collision is never reported as a local node", () => {
	for (const sourceNodeId of [controller.ownNodeId, 2, 9, 232]) {
		const target = getExclusionTarget(nif({ sourceNodeId }), controller);
		expect(target?.callbackNodeId).toBe(0);
		expect(target?.acknowledgementHomeId).toBe(nifOptions.homeId);
	}
});

test("retains the local identity for a NIF on this network", () => {
	const target = getExclusionTarget(
		nif({ homeId: controller.homeId }),
		controller,
	);
	expect(target?.callbackNodeId).toBe(9);
	expect(target?.acknowledgementHomeId).toBeUndefined();
});

test("ignores the actual controller and reserved or unassigned node IDs", () => {
	expect(
		getExclusionTarget(
			nif({
				homeId: controller.homeId,
				sourceNodeId: controller.ownNodeId,
			}),
			controller,
		),
	).toBeUndefined();
	for (const sourceNodeId of [-1, 0, 233, 0xef, 0xff, 1.5, NaN, Infinity]) {
		expect(
			getExclusionTarget(nif({ sourceNodeId }), controller),
		).toBeUndefined();
	}
});

test("accepts directed NIFs only when addressed to this controller", () => {
	expect(
		getExclusionTarget(nif({ destinationNodeId: 1 }), controller),
	).toBeDefined();
	for (const destinationNodeId of [0, 2, 9, 0xef]) {
		expect(
			getExclusionTarget(nif({ destinationNodeId }), controller),
		).toBeUndefined();
	}
});

test("rejects ACK-requesting and malformed exclusion NIFs", () => {
	expect(
		getExclusionTarget(nif({ ackRequested: true }), controller),
	).toBeUndefined();
	for (const payload of [
		[],
		[0x01],
		[0x01, 0x01],
		[0x01, 0x01, 0xd3, 0x9c],
		[0x01, 0x01, 0xd3, 0x9c, 0x01, 0x10],
		[0x01, 0x02, 0xd3, 0x9c, 0x01, 0x10, 0x01],
	]) {
		expect(
			getExclusionTarget(
				nif({ payload: Bytes.from(payload) }),
				controller,
			),
		).toBeUndefined();
	}
});

test("routed, Explorer and ACK frames cannot trigger Classic exclusion", () => {
	const frames = [
		new RoutedZWaveMPDU({
			...nifOptions,
			headerType: MPDUHeaderType.Singlecast,
			routed: true,
			direction: "outbound",
			routedAck: false,
			routedError: false,
			hop: 0,
			repeaters: [2],
		}),
		new NormalExplorerZWaveMPDU({
			...nifOptions,
			headerType: MPDUHeaderType.Explorer,
			routed: false,
			version: 1,
			command: ExplorerFrameCommand.Normal,
			stop: false,
			sourceRouted: false,
			direction: "outbound",
			randomTXInterval: 0,
			ttl: 3,
			repeaters: [],
		}),
		new AckZWaveMPDU(nifOptions),
	];
	for (const frame of frames) {
		expect(getExclusionTarget(frame, controller)).toBeUndefined();
	}
});
