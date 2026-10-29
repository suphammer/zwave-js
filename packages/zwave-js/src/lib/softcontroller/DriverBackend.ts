/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import { join, resolve } from "node:path";

import { ZWaveError, ZWaveErrorCodes, type RFRegion } from "@zwave-js/core";
import type { ZWaveSerialBinding } from "@zwave-js/serial";
import type { DatabaseOptions } from "@zwave-js/shared/bindings";

import type { ControllerFirmwareInfo } from "../driver/ControllerFirmwareInfo.js";
import type { NativeControllerBackend } from "../driver/NativeControllerBackend.js";
import type { ZWaveOptions } from "../driver/ZWaveOptions.js";

import { createControllerBinding } from "./ControllerBackend.js";
import {
	generateRandomHomeId,
	parseControllerState,
	serializeControllerState,
	type PersistedControllerState,
} from "./ControllerState.js";
import {
	SoftwareController,
	type SoftwareControllerState,
} from "./SoftwareController.js";
import type { SoftwareControllerRadio } from "./SoftwareControllerRadio.js";

export interface SoftwareControllerDriverBackendOptions {
	region: RFRegion;
	cacheDir: string;
	databaseOptions?: DatabaseOptions<unknown>;
	homeId?: number;
	ownNodeId?: number;
	transmitChannel?: number;
	inclusionChannel?: number;
	host?: ZWaveOptions["host"];
	radioFactory: () => SoftwareControllerRadio;
	onError: (error: unknown) => void;
	onDiagnostic?: (message: string) => void;
}

interface ActiveController {
	close(): Promise<void>;
	readonly firmwareInfo?: ControllerFirmwareInfo;
}

/** Owns a software controller and its database for the lifetime of one Driver. */
export async function createSoftwareControllerDriverBackend(
	options: SoftwareControllerDriverBackendOptions,
): Promise<NativeControllerBackend> {
	const databaseFactory =
		options.host?.db ?? (await import("#default_bindings/db")).db;
	const databaseOptions = {
		...options.databaseOptions,
		// Losing node allocation or quarantine state can reuse an ID still active over RF.
		ignoreReadErrors: false,
	};
	const statePath = join(resolve(options.cacheDir), "controller.jsonl");
	const database = databaseFactory.createInstance<unknown>(
		statePath,
		databaseOptions,
	);
	if (!database.flush) {
		throw new ZWaveError(
			"Software controller state requires a database binding with durable flush support",
			ZWaveErrorCodes.Driver_InvalidOptions,
		);
	}
	const flush = database.flush.bind(database);
	let persistenceFailure: { error: unknown } | undefined;
	const readState = (): PersistedControllerState | undefined => {
		if (persistenceFailure) throw persistenceFailure.error;
		if (!database.has("state")) {
			if (database.size !== 0) {
				throw new Error(
					`Invalid software controller state in ${statePath}: missing state record`,
				);
			}
			return undefined;
		}
		return parseControllerState(
			JSON.stringify(database.get("state")),
			statePath,
		);
	};
	const persistState = async (
		state: SoftwareControllerState,
	): Promise<void> => {
		if (persistenceFailure) throw persistenceFailure.error;
		const record = JSON.parse(
			serializeControllerState(state.homeId, state.ownNodeId, state),
		);
		try {
			database.set("state", record);
			await flush();
		} catch (error) {
			// Further writes cannot resolve the outcome of an uncertain RF/state commit.
			persistenceFailure ??= { error };
			throw error;
		}
	};
	try {
		await database.open();
		if (!readState()) {
			const homeId = options.homeId ?? generateRandomHomeId();
			const ownNodeId = options.ownNodeId ?? 1;
			await persistState({
				homeId,
				ownNodeId,
				includedNodeIds: [ownNodeId],
				quarantinedNodeIds: [],
				nodeChannels: new Map(),
				nodeNeighbors: new Map(),
				nodeProtocolInfo: new Map(),
				repeaterNodeIds: new Set(),
				routes: new Map(),
			});
		}
	} catch (error) {
		try {
			await database.close();
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"Software controller database initialization and cleanup failed",
			);
		}
		throw error;
	}

	let active: ActiveController | undefined;
	let opening: Promise<ZWaveSerialBinding> | undefined;
	let failedOpeningCleanup: { error: unknown } | undefined;
	let destroyed = false;
	let closing: Promise<void> | undefined;

	const assertAvailable = () => {
		if (destroyed)
			throw new Error("Software controller backend was destroyed");
	};
	const openBinding = async (): Promise<ZWaveSerialBinding> => {
		assertAvailable();
		await active?.close();
		assertAvailable();
		const state = readState();
		assertAvailable();
		if (!state) throw new Error("Software controller state disappeared");
		const transport = new SoftwareController({
			radioFactory: options.radioFactory,
			region: options.region,
			homeId: state.homeId,
			ownNodeId: state.ownNodeId,
			includedNodeIds: state.includedNodeIds,
			quarantinedNodeIds: state.quarantinedNodeIds,
			nodeChannels: state.nodeChannels,
			nodeNeighbors: state.nodeNeighbors,
			nodeProtocolInfo: state.nodeProtocolInfo,
			repeaterNodeIds: state.repeaterNodeIds,
			routes: state.routes,
			channel: options.transmitChannel ?? 0,
			inclusionChannel: options.inclusionChannel,
			onControllerStateChanged: persistState,
			onError: options.onError,
			onDiagnostic: options.onDiagnostic,
		});
		const original = await createControllerBinding({
			transport,
			homeId: state.homeId,
			ownNodeId: state.ownNodeId,
			includedNodeIds: state.includedNodeIds,
			onError: options.onError,
		})();
		let starting: Promise<void> | undefined;
		let stopping: Promise<void> | undefined;
		const close = () =>
			(stopping ??= (async () => {
				await starting?.catch(() => undefined);
				await original.sink.close?.();
			})());
		if (destroyed) {
			try {
				await close();
			} catch (error) {
				failedOpeningCleanup = { error };
				throw error;
			}
			assertAvailable();
		}
		active = {
			close,
			get firmwareInfo() {
				return stopping ? undefined : transport.firmwareInfo;
			},
		};
		const binding: ZWaveSerialBinding = {
			sink: {
				...original.sink,
				start: (controller) => {
					assertAvailable();
					if (stopping) {
						throw new Error(
							"Software controller binding is closing",
						);
					}
					starting ??= Promise.resolve().then(() => {
						assertAvailable();
						if (stopping) {
							throw new Error(
								"Software controller binding is closing",
							);
						}
						return original.sink.start?.(controller);
					});
					return starting;
				},
				close,
				abort: close,
			},
			source: { ...original.source, cancel: close },
		};
		return binding;
	};
	return {
		get firmwareInfo() {
			return destroyed ? undefined : active?.firmwareInfo;
		},
		capabilities: {
			networkWideInclusion: false,
			highPower: false,
			smartStart: false,
			transmitAbort: false,
		},
		binding: () => {
			if (destroyed) {
				return Promise.reject(
					new Error("Software controller backend was destroyed"),
				);
			}
			if (opening) {
				return Promise.reject(
					new Error("Software controller binding is already opening"),
				);
			}
			const operation = openBinding();
			opening = operation;
			return operation.finally(() => {
				if (opening === operation) opening = undefined;
			});
		},
		destroy: () => {
			if (closing) return closing;
			destroyed = true;
			closing = (async () => {
				await opening?.catch(() => undefined);
				if (failedOpeningCleanup) throw failedOpeningCleanup.error;
				await active?.close();
				// A failed stop/commit retains the database lock until explicitly recovered.
				if (persistenceFailure) throw persistenceFailure.error;
				await database.close();
			})();
			return closing;
		},
	};
}
