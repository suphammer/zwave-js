import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BinarySwitchCCSet } from "@zwave-js/cc/BinarySwitchCC";
import {
	ControllerStatus,
	InterviewStage,
	NodeStatus,
	Protocols,
	TransmitOptions,
} from "@zwave-js/core";
import { createDeferredPromise } from "alcalzone-shared/deferred-promise";
import { expect, test as baseTest, vi } from "vitest";

import { InclusionState } from "../controller/Inclusion.js";
import { Driver } from "../driver/Driver.js";
import { cacheKeys } from "../driver/NetworkCache.js";
import {
	ControllerTransmitStatus,
	createControllerBinding,
	type RawControllerTransport,
} from "../softcontroller/ControllerBackend.js";

import { ZWaveNode } from "./Node.js";

async function createFixture() {
	const directory = await mkdtemp(join(tmpdir(), "zwave-status-probe-"));
	const send = vi.fn<RawControllerTransport["send"]>(async () => ({
		status: ControllerTransmitStatus.NoAck,
	}));
	const driver = new Driver(
		createControllerBinding({
			homeId: 0x12345678,
			ownNodeId: 1,
			includedNodeIds: [1, 2],
			transport: { start() {}, send },
		}),
		{
			storage: { cacheDir: directory },
			logConfig: { enabled: false },
			attempts: { nodeInterview: 1 },
			testingHooks: {
				skipNodeInterview: true,
				skipFirmwareIdentification: true,
				loadConfiguration: false,
			},
		},
	);
	const errors: unknown[] = [];
	driver.on("error", (error) => errors.push(error));
	const ready = new Promise<void>((resolve) =>
		driver.once("driver ready", resolve),
	);
	await driver.start();
	await ready;
	const node = driver.controller.nodes.getOrThrow(2);
	driver.cacheSet(cacheKeys.node(2).isListening, true);
	driver.cacheSet(cacheKeys.node(2).isFrequentListening, false);
	return {
		directory,
		driver,
		node,
		send,
		errors,
		close: async () => {
			vi.restoreAllMocks();
			await driver.destroy();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

const test = baseTest.extend<{
	context: Awaited<ReturnType<typeof createFixture>>;
}>({
	context: async ({}, use) => {
		const fixture = await createFixture();
		try {
			await use(fixture);
		} finally {
			await fixture.close();
		}
	},
});

test("a successful quick status check does not request route resolution", async ({
	context,
}) => {
	context.send.mockResolvedValue({ status: ControllerTransmitStatus.OK });
	expect(await context.node.determineStatus()).toBe(true);
	expect(context.node.status).toBe(NodeStatus.Alive);
	expect(context.send).toHaveBeenCalledExactlyOnceWith({
		destinationNodeId: 2,
		command: Uint8Array.of(0),
		transmitOptions: TransmitOptions.ACK,
	});
});

test("a failed quick NOP receives one route-aware NOP and recovers normally", async ({
	context,
}) => {
	context.send
		.mockResolvedValueOnce({ status: ControllerTransmitStatus.NoAck })
		.mockResolvedValueOnce({ status: ControllerTransmitStatus.OK });
	const statuses: string[] = [];
	context.node.on("dead", () => statuses.push("dead"));
	context.node.on("alive", () => statuses.push("alive"));
	expect(await context.node.determineStatus()).toBe(true);
	expect(
		context.send.mock.calls.map(([request]) => request.transmitOptions),
	).toEqual([TransmitOptions.ACK, TransmitOptions.DEFAULT]);
	expect(
		context.send.mock.calls.every(
			([request]) =>
				request.command.length === 1 && request.command[0] === 0,
		),
	).toBe(true);
	expect(statuses).toEqual(["dead", "alive"]);
	expect(context.errors).toEqual([]);
});

test("two failed NOPs finish the status check without a recovery loop", async ({
	context,
}) => {
	expect(await context.node.determineStatus()).toBe(false);
	expect(context.node.status).toBe(NodeStatus.Dead);
	expect(context.send).toHaveBeenCalledTimes(2);
});

test("public ping(false) retains its single short attempt", async ({
	context,
}) => {
	expect(await context.node.ping(false)).toBe(false);
	expect(context.send).toHaveBeenCalledExactlyOnceWith({
		destinationNodeId: 2,
		command: Uint8Array.of(0),
		transmitOptions: TransmitOptions.ACK,
	});
});

test.for([
	{ listening: false, frequent: false },
	{ listening: false, frequent: "250ms" },
	{ listening: false, frequent: "1000ms" },
	{ listening: undefined, frequent: false },
	{ listening: true, frequent: undefined },
])(
	"status recovery excludes sleeping, FLiRS and unknown capabilities: %j",
	async (capabilities, { context }) => {
		context.driver.cacheSet(
			cacheKeys.node(2).isListening,
			capabilities.listening,
		);
		context.driver.cacheSet(
			cacheKeys.node(2).isFrequentListening,
			capabilities.frequent,
		);
		const ping = vi.spyOn(context.node, "ping").mockResolvedValue(false);
		expect(await context.node.determineStatus()).toBe(false);
		expect(ping).toHaveBeenCalledExactlyOnceWith();
	},
);

test("Long Range status checks do not request mesh route resolution", async ({
	context,
}) => {
	vi.spyOn(context.node, "protocol", "get").mockReturnValue(
		Protocols.ZWaveLongRange,
	);
	const ping = vi.spyOn(context.node, "ping").mockResolvedValue(false);
	expect(await context.node.determineStatus()).toBe(false);
	expect(ping).toHaveBeenCalledExactlyOnceWith();
});

test.for([
	InclusionState.Including,
	InclusionState.Excluding,
	InclusionState.Busy,
	InclusionState.SmartStart,
])(
	"commissioning state %s prevents the extra status probe",
	async (state, { context }) => {
		vi.spyOn(
			context.driver.controller,
			"inclusionState",
			"get",
		).mockReturnValue(state);
		const ping = vi.spyOn(context.node, "ping").mockResolvedValue(false);
		expect(await context.node.determineStatus()).toBe(false);
		expect(ping).toHaveBeenCalledExactlyOnceWith();
	},
);

test("concurrent status checks share both probes and release ownership afterward", async ({
	context,
}) => {
	const pending = createDeferredPromise<boolean>();
	const ping = vi
		.spyOn(context.node, "ping")
		.mockReturnValueOnce(pending)
		.mockResolvedValue(true);
	const first = context.node.determineStatus();
	const second = context.node.determineStatus();
	expect(first).toBe(second);
	await vi.waitFor(() => expect(ping).toHaveBeenCalledTimes(1));
	pending.resolve(false);
	expect(await first).toBe(true);
	expect(await second).toBe(true);
	expect(ping.mock.calls).toEqual([[], [true]]);
	expect(await context.node.determineStatus()).toBe(true);
	expect(ping).toHaveBeenCalledTimes(3);
});

test("an already removed node submits no status probe", async ({ context }) => {
	context.driver.controller["_nodes"].delete(2);
	const ping = vi.spyOn(context.node, "ping");
	expect(await context.node.determineStatus()).toBe(false);
	expect(ping).not.toHaveBeenCalled();
	context.node.destroy();
});

test.for(["removed", "replaced", "home", "controller", "destroyed"])(
	"a %s owner during the first probe prevents recovery",
	async (change, { context }) => {
		const pending = createDeferredPromise<boolean>();
		const ping = vi
			.spyOn(context.node, "ping")
			.mockReturnValueOnce(pending);
		const operation = context.node.determineStatus();
		await vi.waitFor(() => expect(ping).toHaveBeenCalledTimes(1));
		if (change === "removed") context.driver.controller["_nodes"].delete(2);
		else if (change === "replaced")
			context.driver.controller["_nodes"].set(
				2,
				new ZWaveNode(2, context.driver),
			);
		else if (change === "home")
			vi.spyOn(
				context.driver.controller,
				"homeId",
				"get",
			).mockReturnValue(0x87654321);
		else if (change === "controller")
			context.driver.controller.setStatus(ControllerStatus.Unresponsive);
		else await context.driver.destroy();
		pending.resolve(false);
		expect(await operation).toBe(false);
		expect(ping).toHaveBeenCalledTimes(1);
		if (change === "removed" || change === "replaced")
			context.node.destroy();
	},
);

test("a removed owner cannot publish a late successful recovery result", async ({
	context,
}) => {
	const pending = createDeferredPromise<boolean>();
	const ping = vi
		.spyOn(context.node, "ping")
		.mockResolvedValueOnce(false)
		.mockReturnValueOnce(pending);
	const operation = context.node.determineStatus();
	await vi.waitFor(() => expect(ping).toHaveBeenCalledTimes(2));
	context.driver.controller["_nodes"].delete(2);
	pending.resolve(true);
	expect(await operation).toBe(false);
	context.node.destroy();
});

test("the incomplete interview uses the internal status helper", async ({
	context,
}) => {
	context.node["setInterviewStage"](InterviewStage.ProtocolInfo);
	const determine = vi
		.spyOn(context.node, "determineStatus")
		.mockResolvedValue(false);
	const task = context.node.getInterviewTask();
	if (task instanceof Promise)
		throw new Error("Expected an incomplete interview task");
	for await (const _ of task.task()) {
		/* Drain the bounded interview. */
	}
	expect(determine).toHaveBeenCalledTimes(1);
	expect(context.send).not.toHaveBeenCalled();
});

test("an unsuccessful application Set is not retried by status recovery", async ({
	context,
}) => {
	await expect(
		context.driver.sendCommand(
			new BinarySwitchCCSet({ nodeId: 2, targetValue: true }),
			{
				maxSendAttempts: 1,
				useSupervision: false,
			},
		),
	).rejects.toThrow();
	expect(context.send).toHaveBeenCalledTimes(1);
	expect(context.send.mock.calls[0][0].command[0]).toBe(0x25);
});

baseTest.for([InterviewStage.Complete, InterviewStage.ProtocolInfo])(
	"a cached node at interview stage %s recovers through automatic startup status checks",
	async (stage) => {
		const initial = await createFixture();
		let driver: Driver | undefined;
		try {
			initial.node["setInterviewStage"](stage);
			const controllerNode =
				initial.driver.controller.nodes.getOrThrow(1);
			controllerNode["setInterviewStage"](InterviewStage.Complete);
			await initial.driver.destroy();
			const send = vi
				.fn<RawControllerTransport["send"]>()
				.mockResolvedValueOnce({
					status: ControllerTransmitStatus.NoAck,
				})
				.mockResolvedValue({ status: ControllerTransmitStatus.OK });
			const requestNodeInformation = vi.fn(async (nodeId: number) => ({
				sourceNodeId: nodeId,
				command: Uint8Array.from([1, 1, 0xd3, 0x9c, 1, 4, 0, 0]),
			}));
			driver = new Driver(
				createControllerBinding({
					homeId: 0x12345678,
					ownNodeId: 1,
					includedNodeIds: [1, 2],
					transport: {
						start() {},
						send,
						requestNodeInformation,
						getNodeProtocolInfo: () =>
							Uint8Array.from([0xd3, 0x9c, 1, 4, 0, 0]),
					},
				}),
				{
					storage: { cacheDir: initial.directory },
					logConfig: { enabled: false },
					attempts: { nodeInterview: 1 },
					testingHooks: {
						skipFirmwareIdentification: true,
						loadConfiguration: false,
					},
				},
			);
			const errors: unknown[] = [];
			driver.on("error", (error) => errors.push(error));
			const determine = vi.spyOn(ZWaveNode.prototype, "determineStatus");
			const interviewed = vi.fn();
			const ready = new Promise<void>((resolve) =>
				driver!.once("driver ready", () => {
					driver!.controller.nodes
						.getOrThrow(2)
						.on("interview completed", interviewed);
					resolve();
				}),
			);
			await driver.start();
			await ready;
			const node = driver.controller.nodes.getOrThrow(2);
			await vi.waitFor(
				() => {
					expect(node.status).toBe(NodeStatus.Alive);
					expect(node.interviewStage).toBe(InterviewStage.Complete);
					expect(node.ready).toBe(true);
				},
				{ timeout: 5000 },
			);
			expect(determine).toHaveBeenCalledExactlyOnceWith();
			expect(
				send.mock.calls.map(([request]) => request.transmitOptions),
			).toEqual([TransmitOptions.ACK, TransmitOptions.DEFAULT]);
			expect(
				send.mock.calls.every(
					([request]) =>
						request.command.length === 1
						&& request.command[0] === 0,
				),
			).toBe(true);
			expect(interviewed).toHaveBeenCalledTimes(
				stage === InterviewStage.Complete ? 0 : 1,
			);
			expect(requestNodeInformation).toHaveBeenCalledTimes(
				stage === InterviewStage.Complete ? 0 : 1,
			);
			expect(errors).toEqual([]);
		} finally {
			vi.restoreAllMocks();
			await driver?.destroy();
			await initial.close();
		}
	},
);
