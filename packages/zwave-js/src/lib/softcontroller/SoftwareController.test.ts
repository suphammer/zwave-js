/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import {
	ChannelConfiguration,
	MPDU,
	ProtocolDataRate,
	RFRegion,
	SinglecastZWaveMPDU,
} from "@zwave-js/core";
import { Bytes } from "@zwave-js/shared";
import { afterEach, expect, test, vi } from "vitest";

import {
	ControllerTransmitStatus,
	type ControllerInclusionEvent,
} from "./ControllerBackend.js";
import {
	parseControllerState,
	serializeControllerState,
} from "./ControllerState.js";
import {
	normalizeInclusionChannel,
	SoftwareController,
} from "./SoftwareController.js";
import type {
	SoftwareControllerMPDURxInfo,
	SoftwareControllerRadio,
} from "./SoftwareControllerRadio.js";

afterEach(() => vi.useRealTimers());

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

test.each([
	{
		workingChannel: 2,
		fatal: false,
		attempts: [0, 2],
		outcome: "protocol-done",
	},
	{
		workingChannel: 1,
		fatal: false,
		attempts: [0, 2, 1],
		outcome: "protocol-done",
	},
	{
		workingChannel: undefined,
		fatal: false,
		attempts: [0, 2, 1],
		outcome: "failed",
	},
	{
		workingChannel: undefined,
		fatal: true,
		attempts: [0],
		outcome: "failed",
	},
])(
	"verifies the assigned node on channel $workingChannel, without exposing uncommitted state ($outcome, fatal=$fatal)",
	async ({ workingChannel, fatal, attempts, outcome }) => {
		vi.useFakeTimers();
		const homeId = 0x12345678;
		const channels = [
			{
				channel: 0,
				dataRate: ProtocolDataRate.ZWave_100k,
				frequency: 869850000,
			},
			{
				channel: 1,
				dataRate: ProtocolDataRate.ZWave_40k,
				frequency: 868400000,
			},
			{
				channel: 2,
				dataRate: ProtocolDataRate.ZWave_9k6,
				frequency: 868400000,
			},
		];
		let receive!: (mpdu: MPDU, info: SoftwareControllerMPDURxInfo) => void;
		const saved: ReturnType<typeof parseControllerState>[] = [];
		const errors: unknown[] = [];
		const verificationChannels: number[] = [];
		const radio: SoftwareControllerRadio = {
			capabilities: {
				localAck: true,
				localTransmitAck: true,
				explorerTargetReply: true,
				routedAckStatus: true,
				explorerTx: false,
				beamTx: false,
			},
			limits: { maximumMPDUSize: 64, maximumBeamMPDUSize: 0 },
			start: async (onMPDU) => {
				receive = onMPDU;
				return {
					region: RFRegion.Europe,
					channelConfig: ChannelConfiguration.Classic,
					channels,
				};
			},
			configure: async () => {},
			stop: async () => {},
			transmit: async (request) => {
				const dataRate = channels.find(
					({ channel }) => channel === request.channel,
				)!.dataRate;
				const frame = MPDU.parse(request.mpdu, {
					region: RFRegion.Europe,
					channel: request.channel,
					protocolDataRate: dataRate,
				});
				if (frame.payload.length !== 1 || frame.payload[0] !== 0)
					return { status: ControllerTransmitStatus.OK };
				if (!(frame instanceof SinglecastZWaveMPDU))
					throw new Error(
						"Verification must use a direct singlecast",
					);
				expect(frame.homeId).toBe(homeId);
				expect(frame.destinationNodeId).toBe(3);
				expect(frame.ackRequested).toBe(true);
				expect(frame.speedModified).toBe(request.channel !== 0);
				expect(request.beamMode).toBeUndefined();
				verificationChannels.push(request.channel);
				if (verificationChannels.length === 1) {
					// Existing nodes can update topology while the new node is awaiting proof.
					receive(
						new SinglecastZWaveMPDU({
							homeId,
							sourceNodeId: 2,
							destinationNodeId: 1,
							ackRequested: false,
							sequenceNumber: 2,
							speedModified: false,
							payload: Bytes.from([0x25, 0x03, 0x00]),
						}),
						{
							channel: 1,
							protocolDataRate: ProtocolDataRate.ZWave_40k,
						},
					);
					await Promise.resolve();
					expect(saved).toHaveLength(1);
					expect(saved[0]?.includedNodeIds).toEqual([1, 2]);
					expect(saved[0]?.nodeProtocolInfo.has(3)).toBe(false);
				}
				return {
					status: fatal
						? ControllerTransmitStatus.Fail
						: request.channel === workingChannel
							? ControllerTransmitStatus.OK
							: ControllerTransmitStatus.NoAck,
				};
			},
		};
		const controller = new SoftwareController({
			radioFactory: () => radio,
			region: RFRegion.Europe,
			homeId,
			includedNodeIds: [1, 2],
			onError: (error) => errors.push(error),
			onControllerStateChanged: (snapshot) => {
				saved.push(
					parseControllerState(
						serializeControllerState(
							snapshot.homeId,
							snapshot.ownNodeId,
							snapshot,
						),
					),
				);
			},
		});
		const events: ControllerInclusionEvent["type"][] = [];
		try {
			await controller.start(() => {});
			await controller.networkManagement.beginInclusion(
				{ nodeType: "any", networkWide: false, highPower: false },
				(event) => events.push(event.type),
			);
			receive(
				new SinglecastZWaveMPDU({
					homeId: 0x87654321,
					sourceNodeId: 0,
					destinationNodeId: 1,
					ackRequested: false,
					sequenceNumber: 1,
					speedModified: false,
					payload: Bytes.from(
						"0101d39c0110015e2527855986725a70327173987aef20",
						"hex",
					),
				}),
				{ channel: 2, protocolDataRate: ProtocolDataRate.ZWave_9k6 },
			);
			await vi.advanceTimersByTimeAsync(50);
			expect(events).toEqual(["node-found", "adding-node", outcome]);
			expect(verificationChannels).toEqual(attempts);
			expect(errors).toEqual([]);
			const final = saved.at(-1)!;
			if (outcome === "protocol-done") {
				expect(final.includedNodeIds).toEqual([1, 2, 3]);
				expect(final.quarantinedNodeIds).toEqual([]);
				expect(final.nodeChannels.get(3)).toBe(workingChannel);
				expect(final.nodeProtocolInfo.has(3)).toBe(true);
			} else {
				expect(final.includedNodeIds).toEqual([1, 2]);
				expect(final.quarantinedNodeIds).toEqual([3]);
				expect(final.nodeChannels.has(3)).toBe(false);
				expect(final.nodeProtocolInfo.has(3)).toBe(false);
			}
		} finally {
			await controller.stop();
		}
	},
);
