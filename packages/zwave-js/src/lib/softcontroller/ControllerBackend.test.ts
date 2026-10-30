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
	parseBitMask,
	parseNodeUpdatePayload,
} from "@zwave-js/core";
import { Bytes } from "@zwave-js/shared";
import { createDeferredPromise } from "alcalzone-shared/deferred-promise";
import { afterEach, expect, test, vi } from "vitest";

import { RemoveNodeReason } from "../controller/Inclusion.js";
import { Driver } from "../driver/Driver.js";

import {
	ControllerTransmitStatus,
	createControllerBinding,
	encodeControllerNodeProtocolInfo,
	encodeExclusionNodeId,
	type ControllerApplicationFrame,
	type ControllerBindingOptions,
	type ControllerFailedNodeManagement,
	type ControllerFailedNodeRemovalResult,
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
	const factory = createControllerBinding({
		homeId: 0x12345678,
		ownNodeId: 1,
		includedNodeIds: [1, 2, 3],
		transport: fixture.transport,
		onError: (error) => errors.push(error),
	});
	const binding = await factory();
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
	const sendRequest = async (
		functionType: SerialApiFunction,
		payload: number[],
	) => {
		await writer.write(
			encodeSerialApiFrame({
				type: SerialApiMessageType.Request,
				functionType,
				payload: Uint8Array.from(payload),
			}),
		);
		await vi.advanceTimersByTimeAsync(0);
	};
	return {
		...fixture,
		frames,
		factory,
		errors,
		receive: async (frame: ControllerApplicationFrame) => {
			fixture.receive(frame);
			await vi.advanceTimersByTimeAsync(0);
		},
		sendRequest,
		request: (nodeId: number) =>
			sendRequest(SerialApiFunction.RequestNodeInfo, [nodeId]),
		cancelSource: async () => {
			await reader.cancel();
			await reading;
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

function failedNodeManagement(
	result: Promise<ControllerFailedNodeRemovalResult> = Promise.resolve(
		"removed",
	),
): ControllerFailedNodeManagement {
	return {
		isFailedNode: vi.fn(() => true),
		removeFailedNode: vi.fn(() => ({ status: "started", result })),
	};
}

test.each([
	undefined,
	{ isFailedNode: () => true },
	{ removeFailedNode: () => ({ status: "failed" }) },
	failedNodeManagement(),
])(
	"failed-node functions require the complete optional backend",
	async (management) => {
		const fixture = await bindingFixture({
			failedNodeManagement: management as
				| ControllerFailedNodeManagement
				| undefined,
		});
		try {
			await fixture.sendRequest(
				SerialApiFunction.GetSerialApiCapabilities,
				[],
			);
			const functions = parseBitMask(
				fixture.frames[0].payload.subarray(8),
			);
			const supported =
				management !== undefined
				&& "isFailedNode" in management
				&& "removeFailedNode" in management;
			expect(functions.includes(SerialApiFunction.IsFailedNode)).toBe(
				supported,
			);
			expect(functions.includes(SerialApiFunction.RemoveFailedNode)).toBe(
				supported,
			);
		} finally {
			await fixture.close();
		}
	},
);

test("IsFailedNode is a local boolean query and rejects invalid target shapes", async () => {
	const management = failedNodeManagement();
	const fixture = await bindingFixture({ failedNodeManagement: management });
	try {
		for (const payload of [[], [2, 1], [0], [1], [4], [233], [255]]) {
			await fixture.sendRequest(SerialApiFunction.IsFailedNode, payload);
			expect(fixture.frames.at(-1)?.payload).toEqual(Uint8Array.of(0));
		}
		expect(management.isFailedNode).not.toHaveBeenCalled();
		await fixture.sendRequest(SerialApiFunction.IsFailedNode, [2]);
		expect(fixture.frames.at(-1)).toMatchObject({
			type: SerialApiMessageType.Response,
			functionType: SerialApiFunction.IsFailedNode,
			payload: Uint8Array.of(1),
		});
		expect(management.isFailedNode).toHaveBeenCalledExactlyOnceWith(2);
		expect(fixture.transport.send).not.toHaveBeenCalled();
	} finally {
		await fixture.close();
	}
});

test.each([
	{ payload: [], flags: 32 },
	{ payload: [2], flags: 32 },
	{ payload: [2, 3, 4], flags: 32 },
	{ payload: [2, 0], flags: 4 },
	{ payload: [0, 1], flags: 8 },
	{ payload: [1, 1], flags: 8 },
	{ payload: [4, 1], flags: 8 },
	{ payload: [233, 1], flags: 8 },
	{ payload: [255, 1], flags: 8 },
])(
	"RemoveFailedNode rejects $payload with start flags $flags",
	async ({ payload, flags }) => {
		const management = failedNodeManagement();
		const fixture = await bindingFixture({
			failedNodeManagement: management,
		});
		try {
			await fixture.sendRequest(
				SerialApiFunction.RemoveFailedNode,
				payload,
			);
			expect(fixture.frames).toEqual([
				{
					type: SerialApiMessageType.Response,
					functionType: SerialApiFunction.RemoveFailedNode,
					payload: Uint8Array.of(flags),
				},
			]);
			expect(management.removeFailedNode).not.toHaveBeenCalled();
		} finally {
			await fixture.close();
		}
	},
);

test.each([
	{ status: "not-failed", flags: 8 },
	{ status: "busy", flags: 16 },
	{ status: "failed", flags: 32 },
] as const)(
	"RemoveFailedNode reports immediate $status without a callback",
	async ({ status, flags }) => {
		const fixture = await bindingFixture({
			failedNodeManagement: {
				isFailedNode: () => true,
				removeFailedNode: () => ({ status }),
			},
		});
		try {
			await fixture.sendRequest(
				SerialApiFunction.RemoveFailedNode,
				[2, 7],
			);
			expect(fixture.frames).toEqual([
				{
					type: SerialApiMessageType.Response,
					functionType: SerialApiFunction.RemoveFailedNode,
					payload: Uint8Array.of(flags),
				},
			]);
		} finally {
			await fixture.close();
		}
	},
);

test.each([
	{ result: "removed", status: 1, retained: false },
	{ result: "node-ok", status: 0, retained: true },
	{ result: "not-removed", status: 2, retained: true },
] as const)(
	"RemoveFailedNode queues acceptance before exact $result callback",
	async ({ result, status, retained }) => {
		const pending =
			createDeferredPromise<ControllerFailedNodeRemovalResult>();
		const fixture = await bindingFixture({
			failedNodeManagement: failedNodeManagement(pending),
		});
		try {
			await fixture.sendRequest(
				SerialApiFunction.RemoveFailedNode,
				[2, 7],
			);
			expect(fixture.frames).toEqual([
				{
					type: SerialApiMessageType.Response,
					functionType: SerialApiFunction.RemoveFailedNode,
					payload: Uint8Array.of(0),
				},
			]);
			pending.resolve(result);
			await vi.advanceTimersByTimeAsync(0);
			expect(fixture.frames[1]).toMatchObject({
				type: SerialApiMessageType.Request,
				functionType: SerialApiFunction.RemoveFailedNode,
				payload: Uint8Array.of(7, status),
			});
			await fixture.sendRequest(
				SerialApiFunction.GetSerialApiInitData,
				[],
			);
			const nodes = parseBitMask(
				fixture.frames.at(-1)!.payload.subarray(3, 32),
			);
			expect(nodes.includes(2)).toBe(retained);
			expect(nodes).toEqual(retained ? [1, 2, 3] : [1, 3]);
		} finally {
			await fixture.close();
		}
	},
);

test("pending failed-node removal rejects competing network operations", async () => {
	const pending = createDeferredPromise<ControllerFailedNodeRemovalResult>();
	const management = failedNodeManagement(pending);
	const factoryDefault = vi.fn();
	const beginInclusion = vi.fn();
	const beginExclusion = vi.fn();
	const fixture = await bindingFixture({
		failedNodeManagement: management,
		factoryDefault,
		networkManagement: {
			beginInclusion,
			beginExclusion,
			stopInclusion: vi.fn(),
			stopExclusion: vi.fn(),
		},
	});
	try {
		await fixture.sendRequest(SerialApiFunction.RemoveFailedNode, [2, 7]);
		await fixture.sendRequest(SerialApiFunction.RemoveFailedNode, [3, 8]);
		expect(fixture.frames.at(-1)?.payload).toEqual(Uint8Array.of(16));
		await fixture.request(3);
		expect(fixture.frames.at(-1)?.payload).toEqual(Uint8Array.of(0));
		await fixture.sendRequest(SerialApiFunction.SendData, [3, 1, 0, 1, 9]);
		expect(fixture.frames.at(-1)?.payload).toEqual(Uint8Array.of(0));
		await fixture.sendRequest(SerialApiFunction.AddNodeToNetwork, [1, 10]);
		await fixture.sendRequest(
			SerialApiFunction.RemoveNodeFromNetwork,
			[1, 11],
		);
		await fixture.sendRequest(SerialApiFunction.HardReset, [12]);
		expect(management.removeFailedNode).toHaveBeenCalledExactlyOnceWith(2);
		expect(fixture.transport.send).not.toHaveBeenCalled();
		expect(factoryDefault).not.toHaveBeenCalled();
		expect(beginInclusion).not.toHaveBeenCalled();
		expect(beginExclusion).not.toHaveBeenCalled();
		pending.resolve("not-removed");
		await vi.advanceTimersByTimeAsync(0);
		await fixture.request(3);
		expect(fixture.frames.at(-1)?.payload).toEqual(Uint8Array.of(1));
	} finally {
		await fixture.close();
	}
});

test("uncertain failed-node persistence withholds callbacks and retains ownership", async () => {
	const pending = createDeferredPromise<ControllerFailedNodeRemovalResult>();
	const fixture = await bindingFixture({
		failedNodeManagement: failedNodeManagement(pending),
	});
	try {
		await fixture.sendRequest(SerialApiFunction.RemoveFailedNode, [2, 7]);
		const failure = new Error("Durable write outcome is unknown");
		pending.reject(failure);
		await vi.advanceTimersByTimeAsync(0);
		expect(fixture.frames).toHaveLength(1);
		expect(fixture.errors).toEqual([failure]);
		await fixture.sendRequest(SerialApiFunction.RemoveFailedNode, [2, 8]);
		expect(fixture.frames.at(-1)?.payload).toEqual(Uint8Array.of(16));
		await fixture.sendRequest(SerialApiFunction.GetSerialApiInitData, []);
		expect(
			parseBitMask(fixture.frames.at(-1)!.payload.subarray(3, 32)),
		).toEqual([1, 2, 3]);
	} finally {
		await fixture.close();
	}
});

test("a durable removal during close survives reopening without a late callback", async () => {
	const pending = createDeferredPromise<ControllerFailedNodeRemovalResult>();
	const fixture = await bindingFixture({
		failedNodeManagement: failedNodeManagement(pending),
		stop: () => pending.then(() => {}),
	});
	await fixture.sendRequest(SerialApiFunction.RemoveFailedNode, [2, 7]);
	const closing = fixture.close();
	await vi.advanceTimersByTimeAsync(0);
	pending.resolve("removed");
	await closing;
	await vi.advanceTimersByTimeAsync(0);
	expect(fixture.frames).toHaveLength(1);
	const reopened = await fixture.factory();
	const writer = new WritableStream(reopened.sink).getWriter();
	const reader = new ReadableStream(reopened.source).getReader();
	try {
		await writer.write(
			encodeSerialApiFrame({
				type: SerialApiMessageType.Request,
				functionType: SerialApiFunction.GetSerialApiInitData,
				payload: new Uint8Array(),
			}),
		);
		const decoder = new SerialApiStreamDecoder();
		let init: SerialApiFrame | undefined;
		while (!init) {
			const { value, done } = await reader.read();
			if (done) throw new Error("Reopened stream ended before init data");
			for (const chunk of decoder.push(value)) {
				if (chunk.kind === "frame") init = chunk.frame;
			}
		}
		expect(parseBitMask(init.payload.subarray(3, 32))).toEqual([1, 3]);
	} finally {
		await reader.cancel();
		await writer.close();
	}
});

test("source cancellation fences later host writes while the writer remains open", async () => {
	const management = failedNodeManagement();
	const factoryDefault = vi.fn();
	const fixture = await bindingFixture({
		failedNodeManagement: management,
		factoryDefault,
	});
	try {
		await fixture.cancelSource();
		await fixture.sendRequest(SerialApiFunction.RemoveFailedNode, [2, 7]);
		await fixture.request(3);
		await fixture.sendRequest(SerialApiFunction.HardReset, [8]);
		expect(management.removeFailedNode).not.toHaveBeenCalled();
		expect(fixture.transport.send).not.toHaveBeenCalled();
		expect(factoryDefault).not.toHaveBeenCalled();
		expect(fixture.frames).toEqual([]);
	} finally {
		await fixture.close();
	}
});

test.each(["removed", "node-ok"] as const)(
	"the real Driver handles failed-node %s without removing another node",
	async (removalResult) => {
		vi.useRealTimers();
		const directory = await mkdtemp(join(tmpdir(), "zwave-failed-node-"));
		const management = failedNodeManagement(Promise.resolve(removalResult));
		const fixture = controllerTransport({
			failedNodeManagement: management,
			send: vi.fn(async () => ({
				status: ControllerTransmitStatus.NoAck,
			})),
		});
		const driver = new Driver(
			createControllerBinding({
				homeId: 0x12345678,
				ownNodeId: 1,
				includedNodeIds: [1, 7, 8],
				transport: fixture.transport,
			}),
			{
				storage: { cacheDir: directory },
				logConfig: { enabled: false },
				testingHooks: {
					skipNodeInterview: true,
					skipFirmwareIdentification: true,
					loadConfiguration: false,
				},
			},
		);
		const errors: unknown[] = [];
		driver.on("error", (error) => errors.push(error));
		try {
			const ready = new Promise<void>((resolve) =>
				driver.once("driver ready", resolve),
			);
			await driver.start();
			await ready;
			const target = driver.controller.nodes.getOrThrow(7);
			const other = driver.controller.nodes.getOrThrow(8);
			const valueId = {
				commandClass: CommandClasses.Basic,
				property: "currentValue",
			};
			target.valueDB.setValue(valueId, 17);
			other.valueDB.setValue(valueId, 42);
			const removed = vi.fn();
			driver.controller.on("node removed", removed);
			expect(await driver.controller.isFailedNode(7)).toBe(true);
			if (removalResult === "removed") {
				await driver.controller.removeFailedNode(7);
				expect(removed).toHaveBeenCalledExactlyOnceWith(
					target,
					RemoveNodeReason.RemoveFailed,
				);
				expect(driver.controller.nodes.has(7)).toBe(false);
				expect(target.valueDB.getValue(valueId)).toBeUndefined();
			} else {
				await expect(
					driver.controller.removeFailedNode(7),
				).rejects.toThrow("has responded");
				expect(removed).not.toHaveBeenCalled();
				expect(driver.controller.nodes.has(7)).toBe(true);
				expect(target.valueDB.getValue(valueId)).toBe(17);
			}
			expect([...driver.controller.nodes.keys()]).toEqual(
				removalResult === "removed" ? [1, 8] : [1, 7, 8],
			);
			expect(other.valueDB.getValue(valueId)).toBe(42);
			expect(management.removeFailedNode).toHaveBeenCalledExactlyOnceWith(
				7,
			);
			expect(fixture.transport.send).toHaveBeenCalledTimes(1);
			expect(fixture.transport.send).toHaveBeenCalledWith({
				destinationNodeId: 7,
				command: Uint8Array.of(0),
				transmitOptions: 1,
			});
			expect(errors).toEqual([]);
		} finally {
			await driver.destroy();
			await rm(directory, { recursive: true, force: true });
		}
	},
);

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
