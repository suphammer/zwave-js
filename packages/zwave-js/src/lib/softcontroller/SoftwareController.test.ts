/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import {
	ChannelConfiguration,
	MPDU,
	ProtocolDataRate,
	RFRegion,
	RoutedZWaveMPDU,
	SinglecastZWaveMPDU,
} from "@zwave-js/core";
import { Bytes } from "@zwave-js/shared";
import { createDeferredPromise } from "alcalzone-shared/deferred-promise";
import { afterEach, expect, test, vi } from "vitest";

import { APPLICATION_RESPONSE_WINDOW_MS } from "./ApplicationResponseWindow.js";
import {
	ControllerTransmitStatus,
	type ControllerApplicationFrame,
	type ControllerInclusionEvent,
	type ControllerTransmitResult,
} from "./ControllerBackend.js";
import {
	parseControllerState,
	serializeControllerState,
} from "./ControllerState.js";
import {
	normalizeInclusionChannel,
	SoftwareController,
	type SoftwareControllerOptions,
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

async function responseRestoreFixture(
	options: Partial<SoftwareControllerOptions> = {},
) {
	vi.useFakeTimers();
	const homeId = options.homeId ?? 0x12345678;
	const region = options.region ?? RFRegion.Europe;
	const channels =
		region === RFRegion.Japan
			? [922500000, 923900000, 926300000].map((frequency, channel) => ({
					channel,
					frequency,
					dataRate: ProtocolDataRate.ZWave_100k,
				}))
			: [
					{
						channel: 0,
						frequency: 869850000,
						dataRate: ProtocolDataRate.ZWave_100k,
					},
					{
						channel: 1,
						frequency: 868400000,
						dataRate: ProtocolDataRate.ZWave_40k,
					},
					{
						channel: 2,
						frequency: 868400000,
						dataRate: ProtocolDataRate.ZWave_9k6,
					},
				];
	const restore = createDeferredPromise<void>();
	void restore.catch(() => undefined);
	const errors: unknown[] = [];
	let receive!: Parameters<SoftwareControllerRadio["start"]>[0];
	let onFrame: ((frame: ControllerApplicationFrame) => void) | undefined;
	const transmit = vi.fn<SoftwareControllerRadio["transmit"]>(async () => ({
		status: ControllerTransmitStatus.OK,
	}));
	const configure = vi.fn<SoftwareControllerRadio["configure"]>(
		async () => {},
	);
	const radio: SoftwareControllerRadio = {
		capabilities: {
			localAck: true,
			localTransmitAck: true,
			explorerTargetReply: true,
			routedAckStatus: true,
			explorerTx: false,
			beamTx: false,
			foreignHomeIdAcknowledgement: true,
		},
		limits: { maximumMPDUSize: 64, maximumBeamMPDUSize: 0 },
		start: async (callback) => {
			receive = callback;
			return {
				region,
				channelConfig: ChannelConfiguration.Classic,
				channels,
			};
		},
		transmit,
		configure,
		stop: async () => {},
	};
	const controller = new SoftwareController({
		radioFactory: () => radio,
		region,
		homeId,
		channel: 1,
		includedNodeIds: [1, 2],
		nodeChannels: new Map([[2, 1]]),
		onControllerStateChanged: () => {},
		onError: (error) => errors.push(error),
		...options,
	});
	await controller.start((frame) => onFrame?.(frame));
	const request = {
		destinationNodeId: 2,
		command: Bytes.from([0x86, 0x13, 0x72]),
		transmitOptions: 1,
	};
	const receiveCommand = (command: Bytes) =>
		receive(
			new SinglecastZWaveMPDU({
				homeId,
				sourceNodeId: 2,
				destinationNodeId: 1,
				ackRequested: false,
				sequenceNumber: 1,
				speedModified: false,
				payload: command,
			}),
			{ channel: 1, protocolDataRate: ProtocolDataRate.ZWave_40k },
		);
	return {
		controller,
		request,
		restore,
		errors,
		transmit,
		configure,
		receiveCommand,
		receiveFrame: (mpdu: MPDU, info: SoftwareControllerMPDURxInfo) =>
			receive(mpdu, info),
		onFrame: (callback: typeof onFrame) => {
			onFrame = callback;
		},
		beginRestore: async () => {
			expect((await controller.send(request)).status).toBe(
				ControllerTransmitStatus.OK,
			);
			configure.mockImplementationOnce(async () => {
				await restore;
			});
			await vi.advanceTimersByTimeAsync(APPLICATION_RESPONSE_WINDOW_MS);
			expect(configure).toHaveBeenCalledTimes(2);
		},
		close: async () => {
			restore.resolve();
			await controller.stop();
		},
	};
}

test("a 350 ms Meter Report survives retained RX, and a new TX supersedes its one-second deadline", async () => {
	const fixture = await responseRestoreFixture({
		channel: 2,
		nodeChannels: new Map([[2, 2]]),
		nodeProtocolInfo: new Map([[2, Bytes.from("d39c00041001", "hex")]]),
	});
	let retainedRx = false;
	const received: ControllerApplicationFrame[] = [];
	fixture.configure.mockImplementation(async () => {
		retainedRx = false;
	});
	fixture.transmit.mockImplementation(async (request) => {
		retainedRx = request.holdRx;
		return { status: ControllerTransmitStatus.OK };
	});
	fixture.onFrame((frame) => received.push(frame));
	const request = {
		...fixture.request,
		command: Bytes.from([0x32, 0x01, 0x00]),
	};
	try {
		// Send completes on the ACK, while RX remains available for a later report.
		expect((await fixture.controller.send(request)).status).toBe(
			ControllerTransmitStatus.OK,
		);
		await vi.advanceTimersByTimeAsync(350);
		const report = Bytes.from([0x32, 0x02, 0x21, 0x11, 0x00, 0x00, 0x00]);
		if (retainedRx) {
			fixture.receiveFrame(
				new SinglecastZWaveMPDU({
					homeId: 0x12345678,
					sourceNodeId: 2,
					destinationNodeId: 1,
					ackRequested: false,
					sequenceNumber: 2,
					speedModified: true,
					payload: report,
				}),
				{ channel: 2, protocolDataRate: ProtocolDataRate.ZWave_9k6 },
			);
		}
		expect(received).toHaveLength(1);
		expect(Array.from(received[0].command)).toEqual(Array.from(report));
		expect(fixture.configure).toHaveBeenCalledTimes(1);
		// The idle window owns no transmit fence and introduces no retune gap.
		expect((await fixture.controller.send(request)).status).toBe(
			ControllerTransmitStatus.OK,
		);
		expect(fixture.transmit).toHaveBeenCalledTimes(2);
		expect(fixture.configure).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(650);
		expect(retainedRx).toBe(true);
		expect(fixture.configure).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(349);
		expect(retainedRx).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		expect(retainedRx).toBe(false);
		expect(fixture.configure).toHaveBeenCalledTimes(2);
	} finally {
		await fixture.close();
	}
});

test("a delayed application response waits for internal RX restoration before its next send", async () => {
	const fixture = await responseRestoreFixture();
	try {
		await fixture.beginRestore();
		let next: Promise<ControllerTransmitResult> | undefined;
		let completed = false;
		fixture.onFrame(() => {
			next = fixture.controller.send(fixture.request).then((result) => {
				completed = true;
				return result;
			});
		});
		fixture.receiveCommand(Bytes.from([0x86, 0x14, 0x72, 2]));
		await Promise.resolve();
		expect(completed).toBe(false);
		expect(fixture.transmit).toHaveBeenCalledTimes(1);
		fixture.restore.resolve();
		expect((await next)?.status).toBe(ControllerTransmitStatus.OK);
		expect(fixture.transmit).toHaveBeenCalledTimes(2);
	} finally {
		await fixture.close();
	}
});

test.each([
	{ nif: "d39c01", channel: 2, modified: true },
	{ nif: "d39c01", channel: 1, modified: true },
	{ nif: "d39c01", channel: 0, modified: false },
	{ nif: "d39c00", channel: 1, modified: false },
	{ nif: "d39c00", channel: 2, modified: true },
	{ nif: undefined, channel: 2, modified: false },
])(
	"serializes normal GET at channel $channel from peer NIF $nif with Speed Modified=$modified",
	async ({ nif, channel, modified }) => {
		const fixture = await responseRestoreFixture({
			channel,
			nodeChannels: new Map([[2, channel]]),
			nodeProtocolInfo: nif
				? new Map([[2, Bytes.from(`${nif}041001`, "hex")]])
				: undefined,
		});
		try {
			expect(
				(await fixture.controller.send(fixture.request)).status,
			).toBe(ControllerTransmitStatus.OK);
			const tx = fixture.transmit.mock.calls[0][0];
			const rate = [
				ProtocolDataRate.ZWave_100k,
				ProtocolDataRate.ZWave_40k,
				ProtocolDataRate.ZWave_9k6,
			][channel];
			const frame = MPDU.parse(tx.mpdu, {
				region: RFRegion.Europe,
				channel,
				protocolDataRate: rate,
			});
			if (!(frame instanceof SinglecastZWaveMPDU))
				throw new Error("Expected a direct GET");
			expect(frame.speedModified).toBe(modified);
			expect(tx.mpdu[5] & 0x10).toBe(modified ? 0x10 : 0);
			expect(frame.homeId).toBe(0x12345678);
			expect(frame.destinationNodeId).toBe(2);
			expect(Array.from(frame.payload)).toEqual(
				Array.from(fixture.request.command),
			);
			expect(tx.holdRx).toBe(true);
		} finally {
			await fixture.close();
		}
	},
);

test.each(["routed", "broadcast", "configuration 3"])(
	"does not apply the direct Classic 1/2 speed flag to %s",
	async (kind) => {
		const configuration3 = kind === "configuration 3";
		const channel = configuration3 ? 0 : 2;
		const region = configuration3 ? RFRegion.Japan : RFRegion.Europe;
		const fixture = await responseRestoreFixture({
			region,
			channel,
			includedNodeIds: [1, 2, 3],
			nodeChannels: new Map([[2, channel]]),
			nodeProtocolInfo: new Map([[2, Bytes.from("d39c01041001", "hex")]]),
			...(kind === "routed" ? { routes: new Map([[2, [3]]]) } : {}),
		});
		try {
			const request =
				kind === "broadcast"
					? { ...fixture.request, destinationNodeId: 0xff }
					: fixture.request;
			expect((await fixture.controller.send(request)).status).toBe(
				ControllerTransmitStatus.OK,
			);
			const tx = fixture.transmit.mock.calls[0][0];
			const frame = MPDU.parse(tx.mpdu, {
				region,
				channel,
				protocolDataRate: configuration3
					? ProtocolDataRate.ZWave_100k
					: ProtocolDataRate.ZWave_9k6,
			});
			if (
				!(
					frame instanceof SinglecastZWaveMPDU
					|| frame instanceof RoutedZWaveMPDU
				)
			)
				throw new Error("Expected a Classic DATA frame");
			expect(frame.speedModified).toBe(false);
			expect(tx.mpdu[5] & 0x10).toBe(0);
		} finally {
			await fixture.close();
		}
	},
);

test("a foreign exclusion's explicit false speed override ignores a numerically matching local 100 kbit/s peer", async () => {
	const fixture = await responseRestoreFixture({
		nodeProtocolInfo: new Map([[2, Bytes.from("d39c01041001", "hex")]]),
	});
	try {
		const events: string[] = [];
		await fixture.controller.networkManagement.beginExclusion(
			{ nodeType: "any", networkWide: false, highPower: false },
			(event) => events.push(event.type),
		);
		fixture.receiveFrame(
			new SinglecastZWaveMPDU({
				homeId: 0x87654321,
				sourceNodeId: 2,
				destinationNodeId: 1,
				ackRequested: false,
				sequenceNumber: 1,
				speedModified: false,
				payload: Bytes.from("0101d39c0010012527", "hex"),
			}),
			{ channel: 1, protocolDataRate: ProtocolDataRate.ZWave_40k },
		);
		await vi.advanceTimersByTimeAsync(50);
		const assignment = fixture.transmit.mock.calls
			.map(([tx]) => ({
				tx,
				frame: MPDU.parse(tx.mpdu, {
					region: RFRegion.Europe,
					channel: tx.channel,
					protocolDataRate:
						tx.channel === 1
							? ProtocolDataRate.ZWave_40k
							: ProtocolDataRate.ZWave_9k6,
				}),
			}))
			.find(
				({ frame }) => frame.payload[0] === 1 && frame.payload[1] === 3,
			);
		expect(assignment).toBeDefined();
		if (!(assignment!.frame instanceof SinglecastZWaveMPDU))
			throw new Error("Expected a direct assignment");
		expect(assignment!.frame.speedModified).toBe(false);
		expect(assignment!.frame.homeId).toBe(0x12345678);
		expect(assignment!.tx.acknowledgementHomeId).toBe(0x87654321);
		expect(events).toEqual(["node-found", "removing-node", "done"]);
	} finally {
		await fixture.close();
	}
});

test("a rejected RX restore fails its waiting send without transmitting", async () => {
	const fixture = await responseRestoreFixture();
	try {
		await fixture.beginRestore();
		const next = fixture.controller.send(fixture.request);
		fixture.restore.reject(new Error("restore failed"));
		expect((await next).status).toBe(ControllerTransmitStatus.Fail);
		expect(fixture.transmit).toHaveBeenCalledTimes(1);
		expect(fixture.configure.mock.lastCall?.[0].autoAck).toBe(false);
		expect(fixture.errors).toHaveLength(1);
	} finally {
		await fixture.close();
	}
});

test("stop while a send awaits RX restoration prevents a later transmission", async () => {
	const fixture = await responseRestoreFixture();
	try {
		await fixture.beginRestore();
		const next = fixture.controller.send(fixture.request);
		const stopping = fixture.controller.stop();
		fixture.restore.resolve();
		await stopping;
		expect((await next).status).toBe(ControllerTransmitStatus.Fail);
		expect(fixture.transmit).toHaveBeenCalledTimes(1);
	} finally {
		await fixture.close();
	}
});

test("factory reset invalidates a send suspended on the previous network's RX restore", async () => {
	const fixture = await responseRestoreFixture();
	try {
		await fixture.beginRestore();
		const next = fixture.controller.send(fixture.request);
		const resetting = fixture.controller.factoryDefault!();
		fixture.restore.resolve();
		await resetting;
		expect((await next).status).toBe(ControllerTransmitStatus.Fail);
		expect(fixture.transmit).toHaveBeenCalledTimes(1);
	} finally {
		await fixture.close();
	}
});

test("concurrent RX-restore waiters still compete for the ordinary transmit fence", async () => {
	const fixture = await responseRestoreFixture();
	try {
		await fixture.beginRestore();
		const first = fixture.controller.send(fixture.request);
		const second = fixture.controller.send(fixture.request);
		fixture.restore.resolve();
		expect((await first).status).toBe(ControllerTransmitStatus.OK);
		expect((await second).status).toBe(ControllerTransmitStatus.NotIdle);
		expect(fixture.transmit).toHaveBeenCalledTimes(2);
	} finally {
		await fixture.close();
	}
});

test("genuine active TX remains NotIdle and is not awaited or reconfigured", async () => {
	const fixture = await responseRestoreFixture();
	const transmitDone = createDeferredPromise<void>();
	try {
		fixture.transmit.mockImplementationOnce(async () => {
			await transmitDone;
			return { status: ControllerTransmitStatus.OK };
		});
		const first = fixture.controller.send(fixture.request);
		expect((await fixture.controller.send(fixture.request)).status).toBe(
			ControllerTransmitStatus.NotIdle,
		);
		expect(
			await fixture.controller.requestNodeInformation(2, 500),
		).toBeUndefined();
		expect(fixture.transmit).toHaveBeenCalledTimes(1);
		expect(fixture.configure).toHaveBeenCalledTimes(1);
		transmitDone.resolve();
		await first;
	} finally {
		transmitDone.resolve();
		await fixture.close();
	}
});

test("Request Node Information waits for RX cleanup before starting its own response window", async () => {
	const fixture = await responseRestoreFixture();
	try {
		await fixture.beginRestore();
		const nif = Bytes.from("0101d39c0010012527", "hex");
		fixture.transmit.mockImplementationOnce(async () => {
			fixture.receiveCommand(nif);
			return { status: ControllerTransmitStatus.OK };
		});
		const next = fixture.controller.requestNodeInformation(2, 500);
		expect(fixture.transmit).toHaveBeenCalledTimes(1);
		fixture.restore.resolve();
		expect((await next)?.command).toEqual(Uint8Array.from(nif));
		expect(fixture.transmit).toHaveBeenCalledTimes(2);
	} finally {
		await fixture.close();
	}
});

test("a node-info request canceled during RX cleanup cannot transmit afterwards", async () => {
	const fixture = await responseRestoreFixture();
	try {
		await fixture.beginRestore();
		const abort = new AbortController();
		const next = fixture.controller.requestNodeInformation(
			2,
			500,
			abort.signal,
		);
		abort.abort();
		fixture.restore.resolve();
		expect(await next).toBeUndefined();
		expect(fixture.transmit).toHaveBeenCalledTimes(1);
	} finally {
		await fixture.close();
	}
});
