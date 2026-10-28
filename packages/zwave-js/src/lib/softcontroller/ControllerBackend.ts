/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import type {
	BasicDeviceClass,
	CommandClasses,
	SerializableTXReport,
} from "@zwave-js/core";
import { encodeNodeUpdatePayload } from "@zwave-js/core";
import type {
	ZWaveSerialBinding,
	ZWaveSerialBindingFactory,
} from "@zwave-js/serial";
import { encodeTXReport } from "@zwave-js/serial/serialapi";
import type { BytesView } from "@zwave-js/shared";

import { isRandomHomeId } from "./ControllerState.js";
import { parseOverAirNodeInformationFrame } from "./NodeInformation.js";
import {
	SerialApiControl,
	type SerialApiControlByte,
	SerialApiFunction,
	type SerialApiFrame,
	SerialApiMessageType,
	SerialApiSetupCommand,
	SerialApiStreamDecoder,
	encodeSerialApiFrame,
} from "./SerialAPI.js";

export enum ControllerTransmitStatus {
	OK = 0x00,
	NoAck = 0x01,
	Fail = 0x02,
	NotIdle = 0x03,
	NoRoute = 0x04,
}

export type ControllerFrameType = "singlecast" | "broadcast" | "multicast";

export interface ControllerTransmitRequest {
	destinationNodeId: number;
	command: BytesView;
	transmitOptions: number;
}

export interface ControllerTransmitResult {
	status: ControllerTransmitStatus;
	/** Present only when the backend observed a real route for this transmission. */
	txReport?: SerializableTXReport;
}

export interface ControllerIdentity {
	readonly homeId: number;
	readonly ownNodeId: number;
}

export interface ControllerRoutingInfoRequest {
	nodeId: number;
	removeNonRepeaters: boolean;
	removeBadLinks: boolean;
}

export interface ControllerReturnRouteRequest {
	sourceNodeId: number;
	destinationNodeId: number;
}

export interface ControllerApplicationFrame {
	sourceNodeId: number;
	command: BytesView;
	frameType?: ControllerFrameType;
	routedBusy?: boolean;
	isExploreFrame?: boolean;
	isForeignFrame?: boolean;
	fromForeignHomeId?: boolean;
}

export type ControllerNetworkManagementNodeType =
	| "any"
	| "controller"
	| "end-node";

export interface ControllerNetworkManagementRequest {
	nodeType: ControllerNetworkManagementNodeType;
	highPower: boolean;
	networkWide: boolean;
}

export interface ControllerNodeInformation {
	nodeId: number;
	basicDeviceClass: BasicDeviceClass;
	genericDeviceClass: number;
	specificDeviceClass: number;
	supportedCCs: readonly CommandClasses[];
	controlledCCs?: readonly CommandClasses[];
}

export type ControllerInclusionEvent =
	| { type: "node-found" }
	| {
			type: "adding-node";
			nodeType: Exclude<ControllerNetworkManagementNodeType, "any">;
			node: ControllerNodeInformation;
	  }
	| { type: "protocol-done" }
	| { type: "failed"; error?: unknown };

export type ControllerExclusionEvent =
	| { type: "node-found" }
	| {
			type: "removing-node";
			nodeType: Exclude<ControllerNetworkManagementNodeType, "any">;
			nodeId: number;
	  }
	| { type: "done" }
	| { type: "failed"; error?: unknown };

/**
 * Protocol-level inclusion/exclusion contract. Implementations must only emit
 * successful events after the corresponding RF/network operation completes;
 * the Driver binding never synthesizes a successful inclusion.
 */
export interface ControllerNetworkManagement {
	beginInclusion(
		request: ControllerNetworkManagementRequest,
		onEvent: (event: ControllerInclusionEvent) => void,
	): Promise<void> | void;
	/** Returns the node ID only when protocol-level inclusion was committed. */
	stopInclusion():
		| Promise<{ nodeId: number } | undefined>
		| { nodeId: number }
		| undefined;
	beginExclusion(
		request: ControllerNetworkManagementRequest,
		onEvent: (event: ControllerExclusionEvent) => void,
	): Promise<void> | void;
	stopExclusion(): Promise<void> | void;
}

/**
 * MAC-level contract between the Driver binding and a software controller.
 * MPDU construction, FCS, radio channel selection and MAC ACK timing remain in
 * the transport implementation, where they can be handled deterministically.
 */
export interface RawControllerTransport {
	/**
	 * Classic Explorer/base payload accepted by this backend. The Driver derives
	 * AutoRoute and direct limits by adding 2 and 8 bytes respectively. Omit this
	 * unless every route the transport may select can accept those derived sizes.
	 */
	readonly maximumPayloadSize?: number;
	start(
		onFrame: (frame: ControllerApplicationFrame) => void,
	): Promise<void> | void;
	stop?(): Promise<void> | void;
	send(request: ControllerTransmitRequest): Promise<ControllerTransmitResult>;
	/**
	 * Omit unless the backend can cancel or fence the active RF operation. Once
	 * resolved, a late completion must not be confused with a later send.
	 */
	abort?(): Promise<void> | void;
	/** Omit unless the transport can report observed one-hop topology. */
	getNodeNeighbors?(
		request: ControllerRoutingInfoRequest,
	): Promise<readonly number[]> | readonly number[];
	/** Omit unless an exact six-byte GetNodeProtocolInfo record is known. */
	getNodeProtocolInfo?(nodeId: number): BytesView | undefined;
	/** Omit unless an ACKed direct-link refresh can be performed safely. */
	updateNodeNeighbors?(nodeId: number): Promise<boolean> | boolean;
	/** Omit unless return-route slots are configured over Protocol CC. */
	assignReturnRoutes?(
		request: ControllerReturnRouteRequest,
	): Promise<ControllerTransmitResult>;
	deleteReturnRoutes?(
		sourceNodeId: number,
	): Promise<ControllerTransmitResult>;
	/**
	 * Cancels/fences active transport work, atomically replaces the controller
	 * identity, and clears all host-owned network state. A resolved operation is
	 * durably committed.
	 */
	factoryDefault?(): Promise<ControllerIdentity> | ControllerIdentity;
	/** Omit unless the transport implements real RF/network inclusion. */
	networkManagement?: ControllerNetworkManagement;
}

export interface ControllerBindingOptions {
	transport: RawControllerTransport;
	homeId: number;
	ownNodeId?: number;
	includedNodeIds?: readonly number[];
	firmwareVersion?: readonly [major: number, minor: number];
	libraryVersion?: string;
	manufacturerId?: number;
	productType?: number;
	productId?: number;
	onError?: (error: unknown) => void;
}

const CLASSIC_NODE_ID_MAX = 232;
const NODE_MASK_BYTES = 29;

const baseSupportedFunctions = [
	SerialApiFunction.GetSerialApiInitData,
	SerialApiFunction.GetControllerCapabilities,
	SerialApiFunction.SendData,
	SerialApiFunction.GetControllerVersion,
	SerialApiFunction.GetControllerId,
	SerialApiFunction.GetNodeProtocolInfo,
	SerialApiFunction.GetSUCNodeId,
	SerialApiFunction.RequestNodeInfo,
] as const;

/** Missing observations must not invent node capabilities or device classes. */
export function encodeControllerNodeProtocolInfo(
	observed: BytesView | undefined,
): BytesView {
	if (observed === undefined) return new Uint8Array(6);
	if (observed.length !== 6) {
		throw new Error(
			"Controller protocol info must contain exactly six bytes",
		);
	}
	return Uint8Array.from(observed);
}

const ADD_NODE_TYPE_ANY = 0x01;
const ADD_NODE_TYPE_CONTROLLER = 0x02;
const ADD_NODE_TYPE_SLAVE = 0x03;
const ADD_NODE_TYPE_STOP = 0x05;
const REMOVE_NODE_TYPE_STOP = 0x05;
const NETWORK_MANAGEMENT_HIGH_POWER = 0x80;
const NETWORK_MANAGEMENT_NETWORK_WIDE = 0x40;
const NETWORK_MANAGEMENT_CALLBACK_GUARD_MS = 10;
const REQUEST_NODE_INFO_TIMEOUT_MS = 5_000;
const APPLICATION_UPDATE_NODE_INFO_RECEIVED = 0x84;
const APPLICATION_UPDATE_NODE_INFO_REQUEST_FAILED = 0x81;

enum AddNodeStatus {
	Ready = 0x01,
	NodeFound = 0x02,
	AddingSlave = 0x03,
	AddingController = 0x04,
	ProtocolDone = 0x05,
	Done = 0x06,
	Failed = 0x07,
}

enum RemoveNodeStatus {
	Ready = 0x01,
	NodeFound = 0x02,
	RemovingSlave = 0x03,
	RemovingController = 0x04,
	Done = 0x06,
	Failed = 0x07,
}

enum NodeNeighborUpdateStatus {
	UpdateStarted = 0x21,
	UpdateDone = 0x22,
	UpdateFailed = 0x23,
}

interface InclusionSession {
	kind: "inclusion";
	callbackId: number;
	phase:
		| "starting"
		| "ready"
		| "node-found"
		| "adding"
		| "protocol-done"
		| "failed";
	guarding: boolean;
	queuedEvents: ControllerInclusionEvent[];
	pendingNode?: ControllerNodeInformation;
}

interface ExclusionSession {
	kind: "exclusion";
	callbackId: number;
	phase: "starting" | "ready" | "node-found" | "removing" | "done" | "failed";
	guarding: boolean;
	queuedEvents: ControllerExclusionEvent[];
	pendingNodeId?: number;
}

type NetworkManagementSession = InclusionSession | ExclusionSession;

interface PendingNodeInfoRequest {
	nodeId: number;
	timeout: ReturnType<typeof setTimeout>;
}

interface PendingNeighborUpdate {
	nodeId: number;
	callbackId: number;
}

interface PendingTransmit {
	callbackId: number;
	aborted: boolean;
}

interface ControllerBindingState extends ControllerIdentity {
	readonly includedNodeIds: readonly number[];
}

function assertByte(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 0 || value > 0xff) {
		throw new RangeError(`${name} must be an unsigned byte`);
	}
}

function assertClassicNodeId(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 1 || value > CLASSIC_NODE_ID_MAX) {
		throw new RangeError(
			`${name} must be a classic Z-Wave node ID (1..${CLASSIC_NODE_ID_MAX})`,
		);
	}
}

function u16be(value: number): BytesView {
	return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

function u32be(value: number): BytesView {
	return Uint8Array.of(
		(value >>> 24) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 8) & 0xff,
		value & 0xff,
	);
}

function concat(...parts: readonly Uint8Array<ArrayBufferLike>[]): BytesView {
	const length = parts.reduce((sum, part) => sum + part.length, 0);
	const result = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

function encodeBitMask(values: readonly number[], bytes: number): BytesView {
	const result = new Uint8Array(bytes);
	for (const value of values) {
		if (value < 1 || value > bytes * 8) continue;
		const index = value - 1;
		result[index >>> 3] = result[index >>> 3] | (1 << (index & 0b111));
	}
	return result;
}

function normalizeOptions(
	options: ControllerBindingOptions,
): Required<
	Pick<
		ControllerBindingOptions,
		| "ownNodeId"
		| "includedNodeIds"
		| "firmwareVersion"
		| "libraryVersion"
		| "manufacturerId"
		| "productType"
		| "productId"
	>
> {
	if (
		!Number.isInteger(options.homeId)
		|| options.homeId < 0
		|| options.homeId > 0xffff_ffff
	) {
		throw new RangeError("homeId must be an unsigned 32-bit integer");
	}
	if (options.transport.maximumPayloadSize !== undefined) {
		assertByte(
			options.transport.maximumPayloadSize,
			"transport maximumPayloadSize",
		);
		if (options.transport.maximumPayloadSize === 0) {
			throw new RangeError(
				"transport maximumPayloadSize must be at least 1",
			);
		}
	}
	const ownNodeId = options.ownNodeId ?? 1;
	assertClassicNodeId(ownNodeId, "ownNodeId");

	const includedNodeIds = [
		...new Set(options.includedNodeIds ?? [ownNodeId]),
	];
	if (!includedNodeIds.includes(ownNodeId))
		includedNodeIds.unshift(ownNodeId);
	for (const nodeId of includedNodeIds) {
		assertClassicNodeId(nodeId, "includedNodeIds entry");
	}

	const firmwareVersion = options.firmwareVersion ?? ([0, 0] as const);
	assertByte(firmwareVersion[0], "firmware major version");
	assertByte(firmwareVersion[1], "firmware minor version");
	const manufacturerId = options.manufacturerId ?? 0xffff;
	const productType = options.productType ?? 0;
	const productId = options.productId ?? 0;
	for (const [value, name] of [
		[manufacturerId, "manufacturerId"],
		[productType, "productType"],
		[productId, "productId"],
	] as const) {
		if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
			throw new RangeError(`${name} must be an unsigned 16-bit integer`);
		}
	}

	return {
		ownNodeId,
		includedNodeIds,
		firmwareVersion,
		libraryVersion: options.libraryVersion ?? "Z-Wave 0.0.0",
		manufacturerId,
		productType,
		productId,
	};
}

class ControllerBindingRuntime {
	readonly #options: ControllerBindingOptions;
	readonly #identity: ReturnType<typeof normalizeOptions>;
	readonly #onControllerStateChanged: (state: ControllerBindingState) => void;
	readonly #includedNodeIds: Set<number>;
	#homeId: number;
	#ownNodeId: number;
	readonly #decoder = new SerialApiStreamDecoder();
	#source: ReadableStreamDefaultController<BytesView> | undefined;
	#pendingSourceChunks: BytesView[] = [];
	#outboundFrames: BytesView[] = [];
	#currentOutbound: BytesView | undefined;
	#networkManagementSession: NetworkManagementSession | undefined;
	#pendingNodeInfoRequest: PendingNodeInfoRequest | undefined;
	#pendingNeighborUpdate: PendingNeighborUpdate | undefined;
	readonly #pendingTransmits = new Set<PendingTransmit>();
	#factoryDefaultInFlight = false;
	#closed = false;
	#stopped = false;

	public constructor(
		options: ControllerBindingOptions,
		onControllerStateChanged: (state: ControllerBindingState) => void,
	) {
		this.#options = options;
		this.#identity = normalizeOptions(options);
		this.#onControllerStateChanged = onControllerStateChanged;
		this.#homeId = options.homeId;
		this.#ownNodeId = this.#identity.ownNodeId;
		this.#includedNodeIds = new Set(this.#identity.includedNodeIds);
	}

	public readonly binding: ZWaveSerialBinding = {
		sink: {
			start: async () => {
				await this.#options.transport.start((frame) => {
					try {
						if (!this.#handleNodeInfoFrame(frame)) {
							this.#emitApplicationCommand(frame);
						}
					} catch (error) {
						this.#reportError(error);
					}
				});
			},
			write: async (chunk) => {
				this.#handleHostBytes(Uint8Array.from(chunk));
			},
			close: async () => {
				await this.#close();
			},
			abort: async () => {
				await this.#close();
			},
		},
		source: {
			start: (controller) => {
				this.#source = controller;
				for (const chunk of this.#pendingSourceChunks) {
					controller.enqueue(chunk);
				}
				this.#pendingSourceChunks = [];
			},
			cancel: async () => {
				await this.#close();
			},
		},
	};

	async #close(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#closed = true;
		this.#decoder.reset();
		this.#outboundFrames = [];
		this.#currentOutbound = undefined;
		this.#networkManagementSession = undefined;
		this.#pendingNeighborUpdate = undefined;
		for (const pending of this.#pendingTransmits) pending.aborted = true;
		this.#pendingTransmits.clear();
		if (this.#pendingNodeInfoRequest) {
			clearTimeout(this.#pendingNodeInfoRequest.timeout);
			this.#pendingNodeInfoRequest = undefined;
		}
		await this.#options.transport.stop?.();
	}

	#reportError(error: unknown): void {
		try {
			this.#options.onError?.(error);
		} catch {
			// Error observers must not change Serial API transaction state.
		}
	}

	#emitBytes(bytes: Uint8Array<ArrayBufferLike>): void {
		if (this.#closed) return;
		const copy: BytesView = Uint8Array.from(bytes);
		if (this.#source) {
			this.#source.enqueue(copy);
		} else {
			this.#pendingSourceChunks.push(copy);
		}
	}

	#handleHostBytes(bytes: Uint8Array<ArrayBufferLike>): void {
		for (const chunk of this.#decoder.push(bytes)) {
			if (chunk.kind === "control") {
				this.#handleHostControl(chunk.control);
			} else if (chunk.kind === "invalid") {
				this.#emitBytes(Uint8Array.of(SerialApiControl.NAK));
			} else {
				this.#emitBytes(Uint8Array.of(SerialApiControl.ACK));
				void this.#handleHostFrame(chunk.frame).catch((error) => {
					this.#reportError(error);
				});
			}
		}
	}

	#handleHostControl(control: SerialApiControlByte): void {
		if (!this.#currentOutbound) return;
		if (control === SerialApiControl.ACK) {
			this.#currentOutbound = undefined;
			this.#flushOutbound();
		} else {
			// NAK and CAN both ask the sender to try the current frame again.
			this.#emitBytes(this.#currentOutbound);
		}
	}

	#queueFrame(frame: SerialApiFrame): void {
		this.#outboundFrames.push(encodeSerialApiFrame(frame));
		this.#flushOutbound();
	}

	#flushOutbound(): void {
		if (
			this.#closed
			|| this.#currentOutbound
			|| this.#outboundFrames.length === 0
		)
			return;
		this.#currentOutbound = this.#outboundFrames.shift();
		this.#emitBytes(this.#currentOutbound!);
	}

	#queueResponse(functionType: number, payload: BytesView): void {
		this.#queueFrame({
			type: SerialApiMessageType.Response,
			functionType,
			payload,
		});
	}

	async #handleHostFrame(frame: SerialApiFrame): Promise<void> {
		if (frame.type !== SerialApiMessageType.Request) return;

		switch (frame.functionType) {
			case SerialApiFunction.GetSerialApiCapabilities:
				this.#queueResponse(
					frame.functionType,
					this.#encodeApiCapabilities(),
				);
				break;
			case SerialApiFunction.SerialAPISetup:
				this.#handleSerialApiSetup(frame.payload);
				break;
			case SerialApiFunction.GetSerialApiInitData:
				this.#queueResponse(frame.functionType, this.#encodeInitData());
				break;
			case SerialApiFunction.GetControllerVersion:
				this.#queueResponse(
					frame.functionType,
					this.#encodeControllerVersion(),
				);
				break;
			case SerialApiFunction.GetControllerCapabilities:
				this.#queueResponse(
					frame.functionType,
					Uint8Array.of(
						0x1c | (this.#includedNodeIds.size === 1 ? 0x20 : 0),
					),
				);
				break;
			case SerialApiFunction.GetControllerId:
				this.#queueResponse(
					frame.functionType,
					concat(u32be(this.#homeId), Uint8Array.of(this.#ownNodeId)),
				);
				break;
			case SerialApiFunction.HardReset:
				await this.#handleHardReset(frame.payload);
				break;
			case SerialApiFunction.GetSUCNodeId:
				// zwave-js requests this with supportCheck=false.
				this.#queueResponse(
					frame.functionType,
					Uint8Array.of(this.#ownNodeId),
				);
				break;
			case SerialApiFunction.SoftReset:
				// Modern zwave-js performs this even when SoftReset is not advertised.
				// Delay the notification until its ACK transaction has completed and
				// the driver has installed the SerialAPIStarted waiter.
				setTimeout(() => this.#emitSerialApiStarted(), 10);
				break;
			case SerialApiFunction.GetNodeProtocolInfo:
				this.#queueResponse(
					frame.functionType,
					this.#encodeNodeProtocolInfo(frame.payload),
				);
				break;
			case SerialApiFunction.GetRoutingInfo:
				await this.#handleGetRoutingInfo(frame.payload);
				break;
			case SerialApiFunction.RequestNodeNeighborUpdate:
				await this.#handleRequestNodeNeighborUpdate(frame.payload);
				break;
			case SerialApiFunction.AssignReturnRoute:
				this.#handleAssignReturnRoute(frame.payload);
				break;
			case SerialApiFunction.DeleteReturnRoute:
				this.#handleDeleteReturnRoute(frame.payload);
				break;
			case SerialApiFunction.RequestNodeInfo:
				this.#handleRequestNodeInfo(frame.payload);
				break;
			case SerialApiFunction.SetApplicationNodeInformation:
				// Unadvertised: the transport cannot change its over-air NIF. A
				// forced request still receives the command's ACK-only completion.
				break;
			case SerialApiFunction.SendData:
				this.#handleSendData(frame.payload);
				break;
			case SerialApiFunction.SendDataAbort:
				if (!this.#options.transport.abort) break;
				for (const pending of this.#pendingTransmits)
					pending.aborted = true;
				await this.#options.transport.abort();
				break;
			case SerialApiFunction.AddNodeToNetwork:
				await this.#handleAddNodeToNetwork(frame.payload);
				break;
			case SerialApiFunction.RemoveNodeFromNetwork:
				await this.#handleRemoveNodeFromNetwork(frame.payload);
				break;
		}
	}

	#encodeApiCapabilities(): BytesView {
		const [major, minor] = this.#identity.firmwareVersion;
		const supportedFunctions: number[] = [...baseSupportedFunctions];
		if (this.#options.transport.networkManagement) {
			supportedFunctions.push(
				SerialApiFunction.AddNodeToNetwork,
				SerialApiFunction.RemoveNodeFromNetwork,
			);
		}
		if (this.#options.transport.maximumPayloadSize !== undefined) {
			supportedFunctions.push(SerialApiFunction.SerialAPISetup);
		}
		if (this.#options.transport.factoryDefault) {
			supportedFunctions.push(SerialApiFunction.HardReset);
		}
		if (this.#options.transport.abort) {
			supportedFunctions.push(SerialApiFunction.SendDataAbort);
		}
		if (this.#options.transport.getNodeNeighbors) {
			supportedFunctions.push(SerialApiFunction.GetRoutingInfo);
		}
		if (
			this.#options.transport.updateNodeNeighbors
			&& this.#options.transport.getNodeNeighbors
		) {
			supportedFunctions.push(
				SerialApiFunction.RequestNodeNeighborUpdate,
			);
		}
		if (
			this.#options.transport.assignReturnRoutes
			&& this.#options.transport.deleteReturnRoutes
		) {
			supportedFunctions.push(
				SerialApiFunction.AssignReturnRoute,
				SerialApiFunction.DeleteReturnRoute,
			);
		}
		return concat(
			Uint8Array.of(major, minor),
			u16be(this.#identity.manufacturerId),
			u16be(this.#identity.productType),
			u16be(this.#identity.productId),
			encodeBitMask(supportedFunctions, 32),
		);
	}

	#handleSerialApiSetup(payload: BytesView): void {
		const maximumPayloadSize = this.#options.transport.maximumPayloadSize;
		const command = payload[0] ?? SerialApiSetupCommand.Unsupported;
		if (maximumPayloadSize === undefined || payload.length !== 1) {
			this.#queueResponse(
				SerialApiFunction.SerialAPISetup,
				Uint8Array.of(SerialApiSetupCommand.Unsupported, command),
			);
			return;
		}

		switch (command) {
			case SerialApiSetupCommand.GetSupportedCommands:
				// The one-byte legacy mask uses the subcommand values as flags.
				this.#queueResponse(
					SerialApiFunction.SerialAPISetup,
					Uint8Array.of(
						SerialApiSetupCommand.GetSupportedCommands,
						SerialApiSetupCommand.GetSupportedCommands
							| SerialApiSetupCommand.GetMaximumPayloadSize,
					),
				);
				break;
			case SerialApiSetupCommand.GetMaximumPayloadSize:
				this.#queueResponse(
					SerialApiFunction.SerialAPISetup,
					Uint8Array.of(command, maximumPayloadSize),
				);
				break;
			default:
				this.#queueResponse(
					SerialApiFunction.SerialAPISetup,
					Uint8Array.of(SerialApiSetupCommand.Unsupported, command),
				);
				break;
		}
	}

	async #handleHardReset(payload: BytesView): Promise<void> {
		const factoryDefault = this.#options.transport.factoryDefault?.bind(
			this.#options.transport,
		);
		const callbackId = payload[0] ?? 0;
		if (
			!factoryDefault
			|| payload.length !== 1
			|| callbackId === 0
			|| this.#factoryDefaultInFlight
		) {
			this.#reportError(
				new Error(
					"Controller factory-default request is invalid or busy",
				),
			);
			return;
		}

		this.#factoryDefaultInFlight = true;
		this.#cancelPendingOperationsForFactoryDefault();
		try {
			const identity = await factoryDefault();
			if (!isRandomHomeId(identity.homeId) || identity.ownNodeId !== 1) {
				throw new Error(
					"Transport returned an invalid factory-default identity",
				);
			}
			this.#homeId = identity.homeId;
			this.#ownNodeId = identity.ownNodeId;
			this.#includedNodeIds.clear();
			this.#includedNodeIds.add(identity.ownNodeId);
			this.#publishControllerState();
			// ZW_SetDefault has no status response. Its standard completion is a
			// request callback containing only the host-provided callback ID.
			this.#queueFrame({
				type: SerialApiMessageType.Request,
				functionType: SerialApiFunction.HardReset,
				payload: Uint8Array.of(callbackId),
			});
		} catch (error) {
			// There is no failure value in the 0x42 callback. Withholding it makes
			// zwave-js time out instead of treating an uncommitted reset as success.
			this.#reportError(error);
		} finally {
			this.#factoryDefaultInFlight = false;
		}
	}

	#publishControllerState(): void {
		this.#onControllerStateChanged({
			homeId: this.#homeId,
			ownNodeId: this.#ownNodeId,
			includedNodeIds: [...this.#includedNodeIds].toSorted(
				(left, right) => left - right,
			),
		});
	}

	#cancelPendingOperationsForFactoryDefault(): void {
		const networkManagementSession = this.#networkManagementSession;
		this.#networkManagementSession = undefined;
		if (networkManagementSession) {
			this.#emitNetworkManagementStatus(
				networkManagementSession.kind === "inclusion"
					? SerialApiFunction.AddNodeToNetwork
					: SerialApiFunction.RemoveNodeFromNetwork,
				networkManagementSession.callbackId,
				networkManagementSession.kind === "inclusion"
					? AddNodeStatus.Failed
					: RemoveNodeStatus.Failed,
			);
		}

		const pendingNeighborUpdate = this.#pendingNeighborUpdate;
		this.#pendingNeighborUpdate = undefined;
		if (pendingNeighborUpdate) {
			this.#emitNeighborUpdateStatus(
				pendingNeighborUpdate.callbackId,
				NodeNeighborUpdateStatus.UpdateFailed,
			);
		}

		const pendingNodeInfoRequest = this.#pendingNodeInfoRequest;
		if (pendingNodeInfoRequest)
			this.#failNodeInfoRequest(pendingNodeInfoRequest);
	}

	#encodeInitData(): BytesView {
		// Legacy API version 9, primary controller, SIS, no timer support.
		return concat(
			Uint8Array.of(9, 0x08, NODE_MASK_BYTES),
			encodeBitMask([...this.#includedNodeIds], NODE_MASK_BYTES),
		);
	}

	#encodeControllerVersion(): BytesView {
		const version = new TextEncoder().encode(
			`${this.#identity.libraryVersion}\0`,
		);
		// 1 = Static Controller
		return concat(version, Uint8Array.of(0x01));
	}

	#emitSerialApiStarted(): void {
		if (this.#closed) return;
		this.#queueFrame({
			type: SerialApiMessageType.Request,
			functionType: SerialApiFunction.SerialAPIStarted,
			// Software reset, watchdog off, always listening, Generic Controller, no
			// advertised NIF CCs, classic Z-Wave only.
			payload: Uint8Array.of(0x07, 0x00, 0x80, 0x01, 0x00, 0x00, 0x00),
		});
	}

	#encodeNodeProtocolInfo(request: BytesView): BytesView {
		const requestedNodeId = request[0] ?? 0;
		if (!this.#includedNodeIds.has(requestedNodeId)) {
			return new Uint8Array(6);
		}

		const observed =
			this.#options.transport.getNodeProtocolInfo?.(requestedNodeId);
		try {
			return encodeControllerNodeProtocolInfo(observed);
		} catch (cause) {
			this.#reportError(
				new Error(
					`Transport returned malformed protocol info for node ${requestedNodeId}`,
					{ cause },
				),
			);
			return new Uint8Array(6);
		}
	}

	async #handleGetRoutingInfo(payload: BytesView): Promise<void> {
		const getNodeNeighbors = this.#options.transport.getNodeNeighbors?.bind(
			this.#options.transport,
		);
		const nodeId = payload[0] ?? 0;
		const options = payload[1] ?? 0;
		let neighbors: readonly number[] = [];

		if (
			getNodeNeighbors
			&& payload.length === 3
			&& payload[2] === 0
			&& (options & 0x3f) === 0
			&& this.#includedNodeIds.has(nodeId)
		) {
			try {
				neighbors = await getNodeNeighbors({
					nodeId,
					removeBadLinks: !!(options & 0x80),
					removeNonRepeaters: !!(options & 0x40),
				});
			} catch (error) {
				this.#reportError(error);
			}
		}

		const validNeighbors = [...new Set(neighbors)].filter(
			(neighborId) =>
				neighborId !== nodeId && this.#includedNodeIds.has(neighborId),
		);
		this.#queueResponse(
			SerialApiFunction.GetRoutingInfo,
			encodeBitMask(validNeighbors, NODE_MASK_BYTES),
		);
	}

	async #handleRequestNodeNeighborUpdate(payload: BytesView): Promise<void> {
		const updateNodeNeighbors =
			this.#options.transport.updateNodeNeighbors?.bind(
				this.#options.transport,
			);
		const nodeId = payload[0] ?? 0;
		const callbackId = payload[1] ?? 0;
		if (
			!updateNodeNeighbors
			|| !this.#options.transport.getNodeNeighbors
			|| payload.length !== 2
			|| callbackId === 0
			|| nodeId === this.#ownNodeId
			|| !this.#includedNodeIds.has(nodeId)
			|| this.#pendingNeighborUpdate
			|| this.#networkManagementSession
			|| this.#factoryDefaultInFlight
		) {
			this.#emitNeighborUpdateStatus(
				callbackId,
				NodeNeighborUpdateStatus.UpdateFailed,
			);
			return;
		}

		const pending: PendingNeighborUpdate = { nodeId, callbackId };
		this.#pendingNeighborUpdate = pending;
		this.#emitNeighborUpdateStatus(
			callbackId,
			NodeNeighborUpdateStatus.UpdateStarted,
		);

		let updated = false;
		try {
			updated = await updateNodeNeighbors(nodeId);
		} catch (error) {
			this.#reportError(error);
		}
		if (this.#pendingNeighborUpdate !== pending || this.#closed) return;
		this.#pendingNeighborUpdate = undefined;
		this.#emitNeighborUpdateStatus(
			callbackId,
			updated
				? NodeNeighborUpdateStatus.UpdateDone
				: NodeNeighborUpdateStatus.UpdateFailed,
		);
	}

	#emitNeighborUpdateStatus(
		callbackId: number,
		status: NodeNeighborUpdateStatus,
	): void {
		if (callbackId === 0 || this.#closed) return;
		this.#queueFrame({
			type: SerialApiMessageType.Request,
			functionType: SerialApiFunction.RequestNodeNeighborUpdate,
			payload: Uint8Array.of(callbackId, status),
		});
	}

	#handleAssignReturnRoute(payload: BytesView): void {
		const assignReturnRoutes =
			this.#options.transport.assignReturnRoutes?.bind(
				this.#options.transport,
			);
		const sourceNodeId = payload[0] ?? 0;
		const destinationNodeId = payload[1] ?? 0;
		const callbackId = payload[2] ?? 0;
		if (
			!assignReturnRoutes
			|| payload.length !== 3
			|| callbackId === 0
			|| sourceNodeId === destinationNodeId
			|| sourceNodeId === this.#ownNodeId
			|| !this.#includedNodeIds.has(sourceNodeId)
			|| !this.#includedNodeIds.has(destinationNodeId)
			|| this.#pendingNeighborUpdate
			|| this.#networkManagementSession
			|| this.#factoryDefaultInFlight
		) {
			this.#queueResponse(
				SerialApiFunction.AssignReturnRoute,
				Uint8Array.of(0),
			);
			return;
		}

		this.#queueResponse(
			SerialApiFunction.AssignReturnRoute,
			Uint8Array.of(1),
		);
		void assignReturnRoutes({
			sourceNodeId,
			destinationNodeId,
		}).then(
			(result) =>
				this.#emitRouteAssignmentReport(
					SerialApiFunction.AssignReturnRoute,
					callbackId,
					result,
				),
			(error) => {
				this.#reportError(error);
				this.#emitRouteAssignmentReport(
					SerialApiFunction.AssignReturnRoute,
					callbackId,
					{
						status: ControllerTransmitStatus.Fail,
					},
				);
			},
		);
	}

	#handleDeleteReturnRoute(payload: BytesView): void {
		const deleteReturnRoutes =
			this.#options.transport.deleteReturnRoutes?.bind(
				this.#options.transport,
			);
		const sourceNodeId = payload[0] ?? 0;
		const callbackId = payload[1] ?? 0;
		if (
			!deleteReturnRoutes
			|| payload.length !== 2
			|| callbackId === 0
			|| sourceNodeId === this.#ownNodeId
			|| !this.#includedNodeIds.has(sourceNodeId)
			|| this.#pendingNeighborUpdate
			|| this.#networkManagementSession
			|| this.#factoryDefaultInFlight
		) {
			this.#queueResponse(
				SerialApiFunction.DeleteReturnRoute,
				Uint8Array.of(0),
			);
			return;
		}

		this.#queueResponse(
			SerialApiFunction.DeleteReturnRoute,
			Uint8Array.of(1),
		);
		void deleteReturnRoutes(sourceNodeId).then(
			(result) =>
				this.#emitRouteAssignmentReport(
					SerialApiFunction.DeleteReturnRoute,
					callbackId,
					result,
				),
			(error) => {
				this.#reportError(error);
				this.#emitRouteAssignmentReport(
					SerialApiFunction.DeleteReturnRoute,
					callbackId,
					{
						status: ControllerTransmitStatus.Fail,
					},
				);
			},
		);
	}

	#emitRouteAssignmentReport(
		functionType:
			| SerialApiFunction.AssignReturnRoute
			| SerialApiFunction.DeleteReturnRoute,
		callbackId: number,
		result: ControllerTransmitResult,
	): void {
		if (callbackId === 0 || this.#closed) return;
		const status = Object.values(ControllerTransmitStatus).includes(
			result.status,
		)
			? result.status
			: ControllerTransmitStatus.Fail;
		this.#queueFrame({
			type: SerialApiMessageType.Request,
			functionType,
			payload: Uint8Array.of(callbackId, status),
		});
	}

	#handleRequestNodeInfo(payload: BytesView): void {
		const nodeId = payload[0] ?? 0;
		if (
			payload.length !== 1
			|| nodeId === this.#ownNodeId
			|| !this.#includedNodeIds.has(nodeId)
			|| this.#pendingNodeInfoRequest
			|| this.#factoryDefaultInFlight
		) {
			this.#queueResponse(
				SerialApiFunction.RequestNodeInfo,
				Uint8Array.of(0),
			);
			return;
		}

		let pending!: PendingNodeInfoRequest;
		const timeout = setTimeout(() => {
			this.#failNodeInfoRequest(pending);
		}, REQUEST_NODE_INFO_TIMEOUT_MS);
		timeout.unref();
		pending = { nodeId, timeout };
		this.#pendingNodeInfoRequest = pending;
		this.#queueResponse(
			SerialApiFunction.RequestNodeInfo,
			Uint8Array.of(1),
		);

		// Z-Wave Protocol CC, Request Node Information Frame. This command does
		// not request a MAC ACK; the node's NIF is the terminal response.
		void this.#options.transport
			.send({
				destinationNodeId: nodeId,
				command: Uint8Array.of(0x01, 0x02),
				transmitOptions: 0,
			})
			.then(
				(result) => {
					if (result.status !== ControllerTransmitStatus.OK) {
						this.#failNodeInfoRequest(pending);
					}
				},
				(error) => {
					this.#reportError(error);
					this.#failNodeInfoRequest(pending);
				},
			);
	}

	#handleNodeInfoFrame(frame: ControllerApplicationFrame): boolean {
		const pending = this.#pendingNodeInfoRequest;
		if (
			!pending
			|| frame.sourceNodeId !== pending.nodeId
			|| frame.command.length < 2
			|| frame.command[0] !== 0x01
			|| frame.command[1] !== 0x01
		)
			return false;

		try {
			const nodeInformation = parseOverAirNodeInformationFrame(
				frame.command.subarray(2),
			);
			this.#completeNodeInfoRequest(pending);
			this.#queueFrame({
				type: SerialApiMessageType.Request,
				functionType: SerialApiFunction.ApplicationUpdate,
				payload: concat(
					Uint8Array.of(APPLICATION_UPDATE_NODE_INFO_RECEIVED),
					encodeNodeUpdatePayload({
						nodeId: frame.sourceNodeId,
						basicDeviceClass: nodeInformation.basicDeviceClass,
						genericDeviceClass: nodeInformation.genericDeviceClass,
						specificDeviceClass:
							nodeInformation.specificDeviceClass,
						supportedCCs: nodeInformation.supportedCCs,
						...(nodeInformation.controlledCCs
							? { controlledCCs: nodeInformation.controlledCCs }
							: {}),
					}),
				),
			});
		} catch {
			this.#failNodeInfoRequest(pending);
		}
		return true;
	}

	#completeNodeInfoRequest(pending: PendingNodeInfoRequest): boolean {
		if (this.#pendingNodeInfoRequest !== pending) return false;
		clearTimeout(pending.timeout);
		this.#pendingNodeInfoRequest = undefined;
		return true;
	}

	#failNodeInfoRequest(pending: PendingNodeInfoRequest): void {
		if (!this.#completeNodeInfoRequest(pending)) return;
		this.#queueFrame({
			type: SerialApiMessageType.Request,
			functionType: SerialApiFunction.ApplicationUpdate,
			payload: Uint8Array.of(APPLICATION_UPDATE_NODE_INFO_REQUEST_FAILED),
		});
	}

	#emitNetworkManagementStatus(
		functionType:
			| SerialApiFunction.AddNodeToNetwork
			| SerialApiFunction.RemoveNodeFromNetwork,
		callbackId: number,
		status: AddNodeStatus | RemoveNodeStatus,
		context: BytesView = new Uint8Array(),
	): void {
		if (callbackId === 0 || this.#closed) return;
		this.#queueFrame({
			type: SerialApiMessageType.Request,
			functionType,
			payload: concat(Uint8Array.of(callbackId, status), context),
		});
	}

	#networkManagementRequest(
		control: number,
		nodeType: number,
	): ControllerNetworkManagementRequest | undefined {
		let normalizedNodeType: ControllerNetworkManagementNodeType;
		switch (nodeType) {
			case ADD_NODE_TYPE_ANY:
				normalizedNodeType = "any";
				break;
			case ADD_NODE_TYPE_CONTROLLER:
				normalizedNodeType = "controller";
				break;
			case ADD_NODE_TYPE_SLAVE:
				normalizedNodeType = "end-node";
				break;
			default:
				return undefined;
		}
		return {
			nodeType: normalizedNodeType,
			highPower: !!(control & NETWORK_MANAGEMENT_HIGH_POWER),
			networkWide: !!(control & NETWORK_MANAGEMENT_NETWORK_WIDE),
		};
	}

	async #handleAddNodeToNetwork(payload: BytesView): Promise<void> {
		const networkManagement = this.#options.transport.networkManagement;
		if (!networkManagement || payload.length !== 2) return;

		const control = payload[0];
		const callbackId = payload[1];
		const addNodeType = control & 0x0f;
		if (this.#factoryDefaultInFlight) {
			this.#emitNetworkManagementStatus(
				SerialApiFunction.AddNodeToNetwork,
				callbackId,
				AddNodeStatus.Failed,
			);
			return;
		}
		if (addNodeType === ADD_NODE_TYPE_STOP) {
			await this.#stopInclusion(callbackId);
			return;
		}

		const request = this.#networkManagementRequest(control, addNodeType);
		if (
			!request
			|| callbackId === 0
			|| this.#networkManagementSession
			|| this.#pendingNeighborUpdate
		) {
			this.#emitNetworkManagementStatus(
				SerialApiFunction.AddNodeToNetwork,
				callbackId,
				AddNodeStatus.Failed,
			);
			return;
		}

		const session: InclusionSession = {
			kind: "inclusion",
			callbackId,
			phase: "starting",
			guarding: false,
			queuedEvents: [],
		};
		this.#networkManagementSession = session;
		try {
			await networkManagement.beginInclusion(request, (event) =>
				this.#handleInclusionEvent(session, event),
			);
		} catch (error) {
			if (this.#networkManagementSession === session) {
				this.#networkManagementSession = undefined;
				this.#reportError(error);
				this.#emitNetworkManagementStatus(
					SerialApiFunction.AddNodeToNetwork,
					callbackId,
					AddNodeStatus.Failed,
				);
			}
			return;
		}

		if (this.#networkManagementSession !== session) return;
		session.phase = "ready";
		this.#emitNetworkManagementStatus(
			SerialApiFunction.AddNodeToNetwork,
			callbackId,
			AddNodeStatus.Ready,
		);
		this.#guardInclusionProgress(session);
	}

	#guardInclusionProgress(session: InclusionSession): void {
		session.guarding = true;
		setTimeout(
			() => this.#releaseInclusionProgress(session),
			NETWORK_MANAGEMENT_CALLBACK_GUARD_MS,
		);
	}

	#releaseInclusionProgress(session: InclusionSession): void {
		if (this.#networkManagementSession !== session || !session.guarding)
			return;
		session.guarding = false;
		const queuedEvents = session.queuedEvents;
		session.queuedEvents = [];
		for (const event of queuedEvents)
			this.#handleInclusionEvent(session, event);
	}

	#handleInclusionEvent(
		session: InclusionSession,
		event: ControllerInclusionEvent,
	): void {
		if (this.#networkManagementSession !== session || this.#closed) return;
		if (session.phase === "starting" || session.guarding) {
			session.queuedEvents.push(event);
			return;
		}
		if (event.type === "failed") {
			this.#failInclusion(session, event.error);
			return;
		}

		try {
			switch (event.type) {
				case "node-found":
					if (session.phase !== "ready") {
						throw new Error(
							`Unexpected inclusion node-found event in ${session.phase} phase`,
						);
					}
					session.phase = "node-found";
					this.#emitNetworkManagementStatus(
						SerialApiFunction.AddNodeToNetwork,
						session.callbackId,
						AddNodeStatus.NodeFound,
					);
					this.#guardInclusionProgress(session);
					break;
				case "adding-node": {
					if (session.phase !== "node-found") {
						throw new Error(
							`Unexpected inclusion adding-node event in ${session.phase} phase`,
						);
					}
					assertClassicNodeId(event.node.nodeId, "included node ID");
					if (
						event.node.nodeId === this.#ownNodeId
						|| this.#includedNodeIds.has(event.node.nodeId)
					) {
						throw new Error(
							`Node ${event.node.nodeId} is already included`,
						);
					}
					for (const [value, name] of [
						[event.node.basicDeviceClass, "basicDeviceClass"],
						[event.node.genericDeviceClass, "genericDeviceClass"],
						[event.node.specificDeviceClass, "specificDeviceClass"],
					] as const) {
						assertByte(value, name);
					}
					const node = {
						...event.node,
						supportedCCs: [...event.node.supportedCCs],
						controlledCCs: [...(event.node.controlledCCs ?? [])],
					};
					const nodeInformation = encodeNodeUpdatePayload(node);
					session.pendingNode = node;
					session.phase = "adding";
					this.#emitNetworkManagementStatus(
						SerialApiFunction.AddNodeToNetwork,
						session.callbackId,
						event.nodeType === "controller"
							? AddNodeStatus.AddingController
							: AddNodeStatus.AddingSlave,
						nodeInformation,
					);
					this.#guardInclusionProgress(session);
					break;
				}
				case "protocol-done":
					if (session.phase !== "adding") {
						throw new Error(
							`Unexpected inclusion protocol-done event in ${session.phase} phase`,
						);
					}
					session.phase = "protocol-done";
					this.#emitNetworkManagementStatus(
						SerialApiFunction.AddNodeToNetwork,
						session.callbackId,
						AddNodeStatus.ProtocolDone,
					);
					break;
			}
		} catch (error) {
			this.#failInclusion(session, error);
		}
	}

	#failInclusion(session: InclusionSession, error?: unknown): void {
		if (
			this.#networkManagementSession !== session
			|| session.phase === "failed"
		)
			return;
		if (error !== undefined) this.#reportError(error);
		session.phase = "failed";
		this.#emitNetworkManagementStatus(
			SerialApiFunction.AddNodeToNetwork,
			session.callbackId,
			AddNodeStatus.Failed,
		);
	}

	async #stopInclusion(callbackId: number): Promise<void> {
		const networkManagement = this.#options.transport.networkManagement!;
		const session = this.#networkManagementSession;
		if (!session || session.kind !== "inclusion") {
			this.#emitNetworkManagementStatus(
				SerialApiFunction.AddNodeToNetwork,
				callbackId,
				AddNodeStatus.Failed,
			);
			return;
		}

		let result: { nodeId: number } | undefined;
		try {
			result = await networkManagement.stopInclusion();
		} catch (error) {
			this.#reportError(error);
		}
		if (this.#networkManagementSession === session) {
			this.#networkManagementSession = undefined;
		}
		if (!result && session.phase !== "protocol-done") {
			// A user-requested stop before a node was assigned is a successful
			// cancellation. Node ID 0 is the conventional "no node" context.
			this.#emitNetworkManagementStatus(
				SerialApiFunction.AddNodeToNetwork,
				callbackId,
				AddNodeStatus.Done,
				Uint8Array.of(0),
			);
			return;
		}

		try {
			if (
				!result
				|| session.phase !== "protocol-done"
				|| !session.pendingNode
			) {
				throw new Error("Inclusion stopped without a committed node");
			}
			assertClassicNodeId(result.nodeId, "included node ID");
			if (result.nodeId !== session.pendingNode.nodeId) {
				throw new Error(
					`Committed node ${result.nodeId} does not match pending node ${session.pendingNode.nodeId}`,
				);
			}
			this.#includedNodeIds.add(result.nodeId);
			this.#publishControllerState();
			this.#emitNetworkManagementStatus(
				SerialApiFunction.AddNodeToNetwork,
				callbackId,
				AddNodeStatus.Done,
				Uint8Array.of(result.nodeId),
			);
		} catch (error) {
			this.#reportError(error);
			this.#emitNetworkManagementStatus(
				SerialApiFunction.AddNodeToNetwork,
				callbackId,
				AddNodeStatus.Failed,
			);
		}
	}

	async #handleRemoveNodeFromNetwork(payload: BytesView): Promise<void> {
		const networkManagement = this.#options.transport.networkManagement;
		if (!networkManagement || payload.length !== 2) return;

		const control = payload[0];
		const callbackId = payload[1];
		const removeNodeType = control & 0x1f;
		if (this.#factoryDefaultInFlight) {
			this.#emitNetworkManagementStatus(
				SerialApiFunction.RemoveNodeFromNetwork,
				callbackId,
				RemoveNodeStatus.Failed,
			);
			return;
		}
		if (removeNodeType === REMOVE_NODE_TYPE_STOP) {
			await this.#stopExclusion(callbackId);
			return;
		}

		const request = this.#networkManagementRequest(control, removeNodeType);
		if (
			!request
			|| callbackId === 0
			|| this.#networkManagementSession
			|| this.#pendingNeighborUpdate
		) {
			this.#emitNetworkManagementStatus(
				SerialApiFunction.RemoveNodeFromNetwork,
				callbackId,
				RemoveNodeStatus.Failed,
			);
			return;
		}

		const session: ExclusionSession = {
			kind: "exclusion",
			callbackId,
			phase: "starting",
			guarding: false,
			queuedEvents: [],
		};
		this.#networkManagementSession = session;
		try {
			await networkManagement.beginExclusion(request, (event) =>
				this.#handleExclusionEvent(session, event),
			);
		} catch (error) {
			if (this.#networkManagementSession === session) {
				this.#networkManagementSession = undefined;
				this.#reportError(error);
				this.#emitNetworkManagementStatus(
					SerialApiFunction.RemoveNodeFromNetwork,
					callbackId,
					RemoveNodeStatus.Failed,
				);
			}
			return;
		}

		if (this.#networkManagementSession !== session) return;
		session.phase = "ready";
		this.#emitNetworkManagementStatus(
			SerialApiFunction.RemoveNodeFromNetwork,
			callbackId,
			RemoveNodeStatus.Ready,
		);
		this.#guardExclusionProgress(session);
	}

	#guardExclusionProgress(session: ExclusionSession): void {
		session.guarding = true;
		setTimeout(
			() => this.#releaseExclusionProgress(session),
			NETWORK_MANAGEMENT_CALLBACK_GUARD_MS,
		);
	}

	#releaseExclusionProgress(session: ExclusionSession): void {
		if (this.#networkManagementSession !== session || !session.guarding)
			return;
		session.guarding = false;
		const queuedEvents = session.queuedEvents;
		session.queuedEvents = [];
		for (const event of queuedEvents)
			this.#handleExclusionEvent(session, event);
	}

	#handleExclusionEvent(
		session: ExclusionSession,
		event: ControllerExclusionEvent,
	): void {
		if (this.#networkManagementSession !== session || this.#closed) return;
		if (session.phase === "starting" || session.guarding) {
			session.queuedEvents.push(event);
			return;
		}
		if (event.type === "failed") {
			this.#failExclusion(session, event.error);
			return;
		}

		try {
			switch (event.type) {
				case "node-found":
					if (session.phase !== "ready") {
						throw new Error(
							`Unexpected exclusion node-found event in ${session.phase} phase`,
						);
					}
					session.phase = "node-found";
					this.#emitNetworkManagementStatus(
						SerialApiFunction.RemoveNodeFromNetwork,
						session.callbackId,
						RemoveNodeStatus.NodeFound,
					);
					this.#guardExclusionProgress(session);
					break;
				case "removing-node":
					if (session.phase !== "node-found") {
						throw new Error(
							`Unexpected exclusion removing-node event in ${session.phase} phase`,
						);
					}
					assertClassicNodeId(event.nodeId, "excluded node ID");
					if (event.nodeId === this.#ownNodeId) {
						throw new Error(
							"The controller cannot exclude its own node ID",
						);
					}
					session.pendingNodeId = event.nodeId;
					session.phase = "removing";
					this.#emitNetworkManagementStatus(
						SerialApiFunction.RemoveNodeFromNetwork,
						session.callbackId,
						event.nodeType === "controller"
							? RemoveNodeStatus.RemovingController
							: RemoveNodeStatus.RemovingSlave,
						Uint8Array.of(event.nodeId),
					);
					this.#guardExclusionProgress(session);
					break;
				case "done":
					if (
						session.phase !== "removing"
						|| session.pendingNodeId === undefined
					) {
						throw new Error(
							`Unexpected exclusion done event in ${session.phase} phase`,
						);
					}
					this.#includedNodeIds.delete(session.pendingNodeId);
					this.#publishControllerState();
					session.phase = "done";
					this.#emitNetworkManagementStatus(
						SerialApiFunction.RemoveNodeFromNetwork,
						session.callbackId,
						RemoveNodeStatus.Done,
					);
					break;
			}
		} catch (error) {
			this.#failExclusion(session, error);
		}
	}

	#failExclusion(session: ExclusionSession, error?: unknown): void {
		if (
			this.#networkManagementSession !== session
			|| session.phase === "failed"
		)
			return;
		if (error !== undefined) this.#reportError(error);
		session.phase = "failed";
		this.#emitNetworkManagementStatus(
			SerialApiFunction.RemoveNodeFromNetwork,
			session.callbackId,
			RemoveNodeStatus.Failed,
		);
	}

	async #stopExclusion(callbackId: number): Promise<void> {
		const networkManagement = this.#options.transport.networkManagement!;
		const session = this.#networkManagementSession;
		if (!session || session.kind !== "exclusion") {
			this.#emitNetworkManagementStatus(
				SerialApiFunction.RemoveNodeFromNetwork,
				callbackId,
				RemoveNodeStatus.Failed,
			);
			return;
		}

		let stopped = true;
		try {
			await networkManagement.stopExclusion();
		} catch (error) {
			stopped = false;
			this.#reportError(error);
		}
		if (this.#networkManagementSession === session) {
			this.#networkManagementSession = undefined;
		}
		this.#emitNetworkManagementStatus(
			SerialApiFunction.RemoveNodeFromNetwork,
			callbackId,
			stopped ? RemoveNodeStatus.Done : RemoveNodeStatus.Failed,
		);
	}

	#handleSendData(payload: BytesView): void {
		if (this.#factoryDefaultInFlight || payload.length < 4) {
			this.#queueResponse(SerialApiFunction.SendData, Uint8Array.of(0));
			return;
		}

		const destinationNodeId = payload[0];
		const commandLength = payload[1];
		const optionsOffset = 2 + commandLength;
		if (payload.length !== optionsOffset + 2 || destinationNodeId === 0) {
			this.#queueResponse(SerialApiFunction.SendData, Uint8Array.of(0));
			return;
		}

		const command = payload.slice(2, optionsOffset);
		const transmitOptions = payload[optionsOffset];
		const callbackId = payload[optionsOffset + 1];
		this.#queueResponse(SerialApiFunction.SendData, Uint8Array.of(1));
		const pending: PendingTransmit = { callbackId, aborted: false };
		this.#pendingTransmits.add(pending);

		void this.#options.transport
			.send({
				destinationNodeId,
				command,
				transmitOptions,
			})
			.then(
				(result) => {
					if (!pending.aborted)
						this.#emitTransmitReport(callbackId, result);
				},
				(error) => {
					this.#reportError(error);
					if (!pending.aborted)
						this.#emitTransmitReport(callbackId, {
							status: ControllerTransmitStatus.Fail,
						});
				},
			)
			.finally(() => this.#pendingTransmits.delete(pending));
	}

	#emitTransmitReport(
		callbackId: number,
		result: ControllerTransmitResult,
	): void {
		if (callbackId === 0 || this.#closed) return;
		let status = result.status;
		if (!Object.values(ControllerTransmitStatus).includes(status)) {
			status = ControllerTransmitStatus.Fail;
		}
		const txReport =
			status === ControllerTransmitStatus.OK
				? result.txReport
				: undefined;
		this.#queueFrame({
			type: SerialApiMessageType.Request,
			functionType: SerialApiFunction.SendData,
			payload: txReport
				? concat(
						Uint8Array.of(callbackId, status),
						encodeTXReport(txReport),
					)
				: Uint8Array.of(callbackId, status),
		});
	}

	#emitApplicationCommand(frame: ControllerApplicationFrame): void {
		assertClassicNodeId(frame.sourceNodeId, "sourceNodeId");
		if (frame.command.length > 0xf9) {
			throw new RangeError("Application command cannot exceed 249 bytes");
		}

		let status = frame.routedBusy ? 0x01 : 0;
		// zwave-js 15.x only preserves the Explore bit when the Serial API frame
		// is also marked TypeBroad. Explorer MPDUs may still carry our node ID as
		// their logical destination, so normalize that wire-level invariant here.
		if (frame.isExploreFrame) status |= 0x04 | 0x10;
		else if (frame.frameType === "broadcast") status |= 0x04;
		else if (frame.frameType === "multicast") status |= 0x08;
		if (frame.isForeignFrame) status |= 0x40;
		if (frame.fromForeignHomeId) status |= 0x80;

		this.#queueFrame({
			type: SerialApiMessageType.Request,
			functionType: SerialApiFunction.ApplicationCommand,
			payload: concat(
				Uint8Array.of(status, frame.sourceNodeId, frame.command.length),
				frame.command,
			),
		});
	}
}

/** Creates an in-process serial binding for a firmware-backed controller. */
export function createControllerBinding(
	options: ControllerBindingOptions,
): ZWaveSerialBindingFactory {
	// Validate eagerly so invalid controller identities fail before opening USB.
	const normalized = normalizeOptions(options);
	let state: ControllerBindingState = {
		homeId: options.homeId,
		ownNodeId: normalized.ownNodeId,
		includedNodeIds: [...normalized.includedNodeIds],
	};
	return async () => {
		const runtime = new ControllerBindingRuntime(
			{
				...options,
				homeId: state.homeId,
				ownNodeId: state.ownNodeId,
				includedNodeIds: state.includedNodeIds,
			},
			(nextState) => {
				state = nextState;
			},
		);
		return runtime.binding;
	};
}
