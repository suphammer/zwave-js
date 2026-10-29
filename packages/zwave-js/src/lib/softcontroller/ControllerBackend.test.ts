/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	CommandClasses,
	InterviewStage,
	NodeStatus,
	parseNodeUpdatePayload,
} from "@zwave-js/core";
import { Bytes } from "@zwave-js/shared";
import { createDeferredPromise } from "alcalzone-shared/deferred-promise";
import { afterEach, expect, test, vi } from "vitest";

import { Driver } from "../driver/Driver.js";

import {
	ControllerTransmitStatus,
	createControllerBinding,
	encodeControllerNodeProtocolInfo,
	encodeExclusionNodeId,
	type ControllerApplicationFrame,
	type ControllerBindingOptions,
	type RawControllerTransport,
} from "./ControllerBackend.js";
import {
	SerialApiControl,
	SerialApiFunction,
	SerialApiMessageType,
	SerialApiStreamDecoder,
	encodeSerialApiFrame,
	type SerialApiFrame,
} from "./SerialAPI.js";

afterEach(() => vi.useRealTimers());

const batteryNIF = Bytes.from(
	"0101539c0107015e86725a738031713070855984",
	"hex",
);

function controllerTransport(options: Partial<RawControllerTransport> = {}) {
	let receive!: (frame: ControllerApplicationFrame) => void;
	const transport: RawControllerTransport = {
		start: (callback) => {
			receive = callback;
		},
		stop: vi.fn(),
		send: vi.fn(async () => ({ status: ControllerTransmitStatus.OK })),
		...options,
	};
	return {
		transport,
		receive: (frame: ControllerApplicationFrame) => receive(frame),
	};
}

async function bindingFixture(options: Partial<RawControllerTransport> = {}) {
	vi.useFakeTimers();
	const fixture = controllerTransport(options);
	const errors: unknown[] = [];
	const binding = await createControllerBinding({
		homeId: 0x12345678,
		ownNodeId: 1,
		includedNodeIds: [1, 2, 3],
		transport: fixture.transport,
		onError: (error) => errors.push(error),
	})();
	const writer = new WritableStream(binding.sink).getWriter();
	const reader = new ReadableStream(binding.source).getReader();
	const decoder = new SerialApiStreamDecoder();
	const frames: SerialApiFrame[] = [];
	const reading = (async () => {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			for (const chunk of decoder.push(value)) {
				if (chunk.kind !== "frame") continue;
				frames.push(chunk.frame);
				await writer.write(Uint8Array.of(SerialApiControl.ACK));
			}
		}
	})();
	await writer.ready;
	return {
		...fixture,
		frames,
		errors,
		receive: async (frame: ControllerApplicationFrame) => {
			fixture.receive(frame);
			await vi.advanceTimersByTimeAsync(0);
		},
		request: async (nodeId: number) => {
			await writer.write(
				encodeSerialApiFrame({
					type: SerialApiMessageType.Request,
					functionType: SerialApiFunction.RequestNodeInfo,
					payload: Uint8Array.of(nodeId),
				}),
			);
			await vi.advanceTimersByTimeAsync(0);
		},
		close: async () => {
			await reader.cancel();
			await reading;
			await writer.close();
		},
	};
}

function updates(frames: SerialApiFrame[]): SerialApiFrame[] {
	return frames.filter(
		(frame) => frame.functionType === SerialApiFunction.ApplicationUpdate,
	);
}

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

test.each([undefined, "singlecast", "broadcast"] as const)(
	"an unsolicited assigned %s NIF becomes a normal node-info update",
	async (frameType) => {
		const fixture = await bindingFixture();
		try {
			await fixture.receive({
				sourceNodeId: 2,
				command: batteryNIF,
				frameType,
			});
			expect(fixture.frames).toHaveLength(1);
			const [update] = updates(fixture.frames);
			expect(update.payload[0]).toBe(0x84);
			expect(
				parseNodeUpdatePayload(update.payload.subarray(1)),
			).toMatchObject({
				nodeId: 2,
				basicDeviceClass: 4,
				genericDeviceClass: 7,
				specificDeviceClass: 1,
				supportedCCs: expect.arrayContaining([
					CommandClasses["Wake Up"],
					CommandClasses["Manufacturer Specific"],
				]),
			});
			expect(fixture.transport.send).not.toHaveBeenCalled();
			expect(fixture.errors).toEqual([]);
		} finally {
			await fixture.close();
		}
	},
);

test("another included node's unsolicited NIF preserves the active request", async () => {
	const fixture = await bindingFixture();
	try {
		await fixture.request(2);
		await fixture.receive({
			sourceNodeId: 3,
			command: Uint8Array.of(1, 1),
		});
		await fixture.receive({
			sourceNodeId: 2,
			command: batteryNIF,
			isForeignFrame: true,
		});
		expect(updates(fixture.frames)).toEqual([]);
		await fixture.receive({ sourceNodeId: 3, command: batteryNIF });
		expect(
			updates(fixture.frames).map((frame) => frame.payload[1]),
		).toEqual([3]);
		await fixture.request(3);
		expect(fixture.frames.at(-1)).toMatchObject({
			functionType: SerialApiFunction.RequestNodeInfo,
			payload: Uint8Array.of(0),
		});
		await fixture.receive({ sourceNodeId: 2, command: batteryNIF });
		expect(
			updates(fixture.frames).map((frame) => frame.payload[1]),
		).toEqual([3, 2]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(updates(fixture.frames)).toHaveLength(2);
		await fixture.request(3);
		expect(fixture.frames.at(-1)?.payload).toEqual(Uint8Array.of(1));
	} finally {
		await fixture.close();
	}
});

test.each([
	{ kind: "truncated Protocol header", command: Uint8Array.of(1) },
	{ kind: "missing NIF body", command: Uint8Array.of(1, 1) },
	{
		kind: "truncated device classes",
		command: Bytes.from("0101539c0107", "hex"),
	},
	{
		kind: "truncated extended CC",
		command: Bytes.from("0101539c010701f1", "hex"),
	},
	{
		kind: "oversized Serial API update",
		command: Bytes.concat([batteryNIF, new Uint8Array(255).fill(0x20)]),
	},
])(
	"a NIF with $kind is consumed and fails only a matching pending request",
	async ({ command }) => {
		const fixture = await bindingFixture();
		try {
			await fixture.receive({ sourceNodeId: 2, command });
			expect(fixture.frames).toEqual([]);
			await fixture.request(2);
			await fixture.receive({ sourceNodeId: 2, command });
			expect(
				updates(fixture.frames).map((frame) =>
					Array.from(frame.payload),
				),
			).toEqual([[0x81]]);
			expect(
				fixture.frames.some(
					(frame) =>
						frame.functionType
						=== SerialApiFunction.ApplicationCommand,
				),
			).toBe(false);
			await fixture.request(3);
			expect(fixture.frames.at(-1)?.payload).toEqual(Uint8Array.of(1));
		} finally {
			await fixture.close();
		}
	},
);

test.each([
	{ sourceNodeId: 0 },
	{ sourceNodeId: 1 },
	{ sourceNodeId: 4 },
	{ sourceNodeId: 233 },
	{ sourceNodeId: 255 },
	{ sourceNodeId: -1 },
	{ sourceNodeId: 1.5 },
	{ sourceNodeId: NaN },
	{ sourceNodeId: Infinity },
	{ isForeignFrame: true },
	{ fromForeignHomeId: true },
	{ isExploreFrame: true },
	{ routedBusy: true },
	{ frameType: "multicast" as const },
])(
	"ineligible NIF %j cannot update a node or consume its own pending request",
	async (overrides) => {
		const fixture = await bindingFixture();
		try {
			await fixture.request(2);
			await fixture.receive({
				sourceNodeId: 2,
				command: batteryNIF,
				...overrides,
			});
			expect(updates(fixture.frames)).toEqual([]);
			expect(
				fixture.frames.some(
					(frame) =>
						frame.functionType
						=== SerialApiFunction.ApplicationCommand,
				),
			).toBe(false);
			await fixture.receive({ sourceNodeId: 2, command: batteryNIF });
			expect(
				updates(fixture.frames).map((frame) => frame.payload[1]),
			).toEqual([2]);
		} finally {
			await fixture.close();
		}
	},
);

test.each([
	{
		kind: "another included node",
		response: { sourceNodeId: 3, command: batteryNIF },
	},
	{
		kind: "a foreign Home ID",
		response: {
			sourceNodeId: 2,
			command: batteryNIF,
			isForeignFrame: true,
		},
	},
	{
		kind: "a malformed NIF",
		response: { sourceNodeId: 2, command: Uint8Array.of(1, 1) },
	},
])(
	"a bounded transport result from $kind cannot leave its request registered",
	async ({ response }) => {
		const result = createDeferredPromise<
			ControllerApplicationFrame | undefined
		>();
		let signal: AbortSignal | undefined;
		const fixture = await bindingFixture({
			requestNodeInformation: async (_nodeId, _timeoutMs, abort) => {
				signal = abort;
				return result;
			},
		});
		try {
			await fixture.request(2);
			result.resolve(response);
			await vi.advanceTimersByTimeAsync(0);
			expect(updates(fixture.frames).at(-1)?.payload).toEqual(
				Uint8Array.of(0x81),
			);
			expect(signal?.aborted).toBe(true);
			await fixture.request(3);
			expect(
				fixture.frames.findLast(
					(frame) =>
						frame.type === SerialApiMessageType.Response
						&& frame.functionType
							=== SerialApiFunction.RequestNodeInfo,
				)?.payload,
			).toEqual(Uint8Array.of(1));
		} finally {
			await fixture.close();
		}
	},
);

test("ordinary application commands retain their application callback", async () => {
	const fixture = await bindingFixture();
	try {
		await fixture.receive({
			sourceNodeId: 2,
			command: Uint8Array.of(0x25, 3, 0xff),
		});
		expect(fixture.frames).toHaveLength(1);
		expect(fixture.frames[0].functionType).toBe(
			SerialApiFunction.ApplicationCommand,
		);
	} finally {
		await fixture.close();
	}
});

test("an unsolicited battery NIF wakes the real Driver and resumes its queued interview", async () => {
	vi.useRealTimers();
	const directory = await mkdtemp(join(tmpdir(), "zwave-unsolicited-nif-"));
	const requested = createDeferredPromise<void>();
	const requestNodeInformation = vi.fn<
		NonNullable<RawControllerTransport["requestNodeInformation"]>
	>(async (_nodeId, _timeoutMs, signal) => {
		requested.resolve();
		return new Promise((resolve) =>
			signal?.addEventListener("abort", () => resolve(undefined), {
				once: true,
			}),
		);
	});
	const fixture = controllerTransport({
		getNodeProtocolInfo: () => Bytes.from("539c01040701", "hex"),
		requestNodeInformation,
	});
	const options: ControllerBindingOptions = {
		homeId: 0x12345678,
		ownNodeId: 1,
		includedNodeIds: [1, 2],
		transport: fixture.transport,
	};
	const driver = new Driver(createControllerBinding(options), {
		storage: { cacheDir: directory },
		logConfig: { enabled: false },
		testingHooks: {
			skipFirmwareIdentification: true,
			loadConfiguration: false,
		},
	});
	const errors: unknown[] = [];
	driver.on("error", (error) => errors.push(error));
	try {
		const ready = new Promise<void>((resolve) =>
			driver.once("driver ready", resolve),
		);
		await driver.start();
		await ready;
		const node = driver.controller.nodes.getOrThrow(2);
		await vi.waitFor(() => expect(node.status).toBe(NodeStatus.Asleep));
		expect(node.interviewStage).toBe(InterviewStage.ProtocolInfo);
		expect(requestNodeInformation).not.toHaveBeenCalled();
		const awake = new Promise<void>((resolve) =>
			node.once("wake up", () => resolve()),
		);
		fixture.receive({
			sourceNodeId: 2,
			command: batteryNIF,
			frameType: "broadcast",
		});
		await awake;
		await requested;
		expect(node.status).toBe(NodeStatus.Awake);
		expect(node.supportsCC(CommandClasses["Wake Up"])).toBe(true);
		expect(node.supportsCC(CommandClasses["Manufacturer Specific"])).toBe(
			true,
		);
		expect(requestNodeInformation).toHaveBeenCalledTimes(1);
		expect(errors).toEqual([]);
	} finally {
		await driver.destroy();
		await rm(directory, { recursive: true, force: true });
	}
});
