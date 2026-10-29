/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import {
	ChannelConfiguration,
	ExplorerFrameCommand,
	ExplorerZWaveMPDU,
	LongRangeMPDU,
	type MPDU,
	MPDUHeaderType,
	MulticastZWaveMPDU,
	ProtocolDataRate,
	ProtocolHeaderFormat,
	type RFRegion,
	RoutedZWaveMPDU,
	RoutingScheme,
	SinglecastZWaveMPDU,
	NodeType,
	NormalExplorerZWaveMPDU,
	SearchResultExplorerZWaveMPDU,
	getProtocolHeaderFormat,
	protocolDataRateToString,
	rfRegionToRadioProtocolMode,
	type NodeInformationFrame,
} from "@zwave-js/core";
import { Bytes, type BytesView } from "@zwave-js/shared";

import type { ControllerFirmwareInfo } from "../driver/ControllerFirmwareInfo.js";

import { canMatchAcknowledgementHomeId } from "./AcknowledgementHomeId.js";
import {
	ApplicationResponseWindow,
	shouldHoldApplicationResponse,
} from "./ApplicationResponseWindow.js";
import {
	ControllerTransmitStatus,
	type ControllerApplicationFrame,
	type ControllerExclusionEvent,
	type ControllerIdentity,
	type ControllerInclusionEvent,
	type ControllerNetworkManagement,
	type ControllerNetworkManagementRequest,
	type ControllerReturnRouteRequest,
	type ControllerRoutingInfoRequest,
	type ControllerTransmitRequest,
	type ControllerTransmitResult,
	type RawControllerTransport,
} from "./ControllerBackend.js";
import { generateRandomHomeId } from "./ControllerState.js";
import {
	getInclusionVerificationChannels,
	shouldSetSpeedModified,
} from "./DataRate.js";
import { getExclusionTarget } from "./Exclusion.js";
import {
	isNodeInformationFrameForController,
	parseOverAirNodeInformationFrame,
} from "./NodeInformation.js";
import { NodeInformationRequest } from "./NodeInformationRequest.js";
import { findRoutes, MAX_RETURN_ROUTES } from "./RouteManager.js";
import type {
	SoftwareControllerRadio,
	SoftwareControllerRegionConfig,
	SoftwareControllerBeamMode,
	SoftwareControllerMPDURxInfo,
	SoftwareControllerRadioTransmitOptions,
} from "./SoftwareControllerRadio.js";

const BEAM_MODE_SHORT: SoftwareControllerBeamMode = "250ms";
const BEAM_MODE_LONG: SoftwareControllerBeamMode = "1000ms";
// FLiRS nodes must remain awake for at least two seconds after communication.
// Reuse that window for a burst instead of paying for a new beam per command.
const FLIRS_AWAKE_HOLD_MS = 2_000;
const FLIRS_AWAKE_TX_GUARD_MS = 500;
const TRANSMIT_OPTION_ACK = 0x01;
const TRANSMIT_OPTION_EXPLORE = 0x20;
const CLASSIC_NODE_ID_MAX = 232;
const NODE_ID_BROADCAST = 0xff;
const NODE_ID_LEARN_MODE = 0xef;
const PROTOCOL_CC = 0x01;
const PROTOCOL_COMMAND_COMPLETE = 0x07;
const PROTOCOL_FIND_NODES_IN_RANGE = 0x04;
const PROTOCOL_GET_NODES_IN_RANGE = 0x05;
const PROTOCOL_RANGE_INFO = 0x06;
const PROTOCOL_ASSIGN_RETURN_ROUTE = 0x0c;
const CONTROLLER_REPLICATION_TIMEOUT_MS = 10_000;
const CONTROLLER_REPLICATION_CHANNEL_TIMEOUT_MS = 250;
const CONTROLLER_NEIGHBOR_DISCOVERY_DELAY_MS = 3_700;
const CONTROLLER_ASSIGNMENT_SETTLE_MS = 250;
const NODE_NEIGHBOR_UPDATE_TIMEOUT_MS = 10_000;
const EXPLORER_RESULT_TIMEOUT_MS = 5_000;

export interface SoftwareControllerState extends ControllerIdentity {
	readonly includedNodeIds: readonly number[];
	/** IDs that may exist over RF after an inclusion failed post-assignment. */
	readonly quarantinedNodeIds: readonly number[];
	readonly nodeChannels: ReadonlyMap<number, number>;
	readonly nodeNeighbors: ReadonlyMap<number, readonly number[]>;
	readonly nodeProtocolInfo: ReadonlyMap<number, Uint8Array>;
	readonly repeaterNodeIds: ReadonlySet<number>;
	readonly routes: ReadonlyMap<number, readonly number[]>;
}

export interface SoftwareControllerOptions {
	radioFactory: () => SoftwareControllerRadio;
	region: RFRegion;
	channelConfiguration?: ChannelConfiguration;
	homeId: number;
	ownNodeId?: number;
	/** Nodes already assigned to this controller network. */
	includedNodeIds?: readonly number[];
	/** Persisted IDs reserved after an incomplete post-assignment inclusion. */
	quarantinedNodeIds?: readonly number[];
	/** Last known logical channel for each included non-controller node. */
	nodeChannels?: ReadonlyMap<number, number>;
	/** Protocol-reported directed neighbor rows. */
	nodeNeighbors?: ReadonlyMap<number, readonly number[]>;
	/** Six-byte protocol-info records captured from each node's NIF. */
	nodeProtocolInfo?: ReadonlyMap<number, Uint8Array>;
	/** Included nodes whose NIF or operator configuration confirms routing. */
	repeaterNodeIds?: ReadonlySet<number>;
	/** Explicit classic routed paths. The destination is the map key. */
	routes?: ReadonlyMap<number, readonly number[]>;
	/** Fixed classic channel used for direct transmissions. Defaults to 0. */
	channel?: number;
	/** Logical channel for inclusion; defaults to the region's 9.6 kbit/s channel. */
	inclusionChannel?: number;
	/** Signed deci-dBm, or undefined to retain the radio power setting. */
	txPowerDeciDbm?: number;
	/** Number of radio-local TX/ACK attempts. */
	maxAttempts?: 1 | 2 | 3;
	/** Enable radio CCA before each attempt. Defaults to true. */
	cca?: boolean;
	/** Delay between Find Nodes and Get Nodes. Defaults to the native 3700 ms. */
	controllerNeighborDiscoveryDelayMs?: number;
	onError?: (error: unknown) => void;
	onDiagnostic?: (message: string) => void;
	/** Called after committed network membership or learned PHY state changes. */
	onControllerStateChanged?: (
		state: SoftwareControllerState,
	) => Promise<void> | void;
}

interface NormalizedOptions {
	region: RFRegion;
	channelConfiguration: ChannelConfiguration;
	homeId: number;
	ownNodeId: number;
	channel: number;
	inclusionChannel: number | undefined;
	txPower: number | undefined;
	maxAttempts: 1 | 2 | 3;
	cca: boolean;
	controllerNeighborDiscoveryDelayMs: number;
	includedNodeIds: readonly number[];
	quarantinedNodeIds: readonly number[];
	nodeChannels: ReadonlyMap<number, number>;
	nodeNeighbors: ReadonlyMap<number, readonly number[]>;
	nodeProtocolInfo: ReadonlyMap<number, Bytes>;
	repeaterNodeIds: ReadonlySet<number>;
	routes: ReadonlyMap<number, readonly number[]>;
}

interface ExplorerResultWaiter {
	readonly destinationNodeId: number;
	readonly frameHandle: number;
	readonly resolve: (result: SearchResultExplorerZWaveMPDU) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface ProtocolCommandWaiter {
	sourceNodeId: number;
	predicate: (command: BytesView) => boolean;
	resolve: (command: Bytes) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface InclusionManagementSession {
	kind: "inclusion";
	request: ControllerNetworkManagementRequest;
	onEvent: (event: ControllerInclusionEvent) => void;
	ready: Promise<void>;
	operation?: Promise<void>;
	committedNodeId?: number;
	assignedNodeId?: number;
	lastCommandCompleteSequence?: number;
	commandWaiter?: InclusionCommandWaiter;
	presentationTimer?: ReturnType<typeof setTimeout>;
	failed: boolean;
	stopping: boolean;
}

interface InclusionCommandWaiter {
	sourceNodeId: number;
	description: string;
	predicate: (command: BytesView) => boolean;
	resolve: (received: InclusionProtocolCommand) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface InclusionProtocolCommand {
	command: Bytes;
	channel: number;
}

interface ExclusionManagementSession {
	kind: "exclusion";
	request: ControllerNetworkManagementRequest;
	onEvent: (event: ControllerExclusionEvent) => void;
	ready: Promise<void>;
	operation?: Promise<void>;
	presentationTimer?: ReturnType<typeof setTimeout>;
	failed: boolean;
	stopping: boolean;
}

type NetworkManagementSession =
	| InclusionManagementSession
	| ExclusionManagementSession;

type MPDURxInfo = SoftwareControllerMPDURxInfo;

export function normalizeInclusionChannel(
	value: number | undefined,
): number | undefined {
	if (
		value !== undefined
		&& (!Number.isInteger(value) || value < 0 || value > 0xff)
	) {
		throw new RangeError("inclusionChannel must be an unsigned byte");
	}
	return value;
}

function normalizeOptions(
	options: SoftwareControllerOptions,
): NormalizedOptions {
	if (
		!Number.isInteger(options.homeId)
		|| options.homeId < 0
		|| options.homeId > 0xffff_ffff
	) {
		throw new RangeError("homeId must be an unsigned 32-bit integer");
	}
	const ownNodeId = options.ownNodeId ?? 1;
	if (
		!Number.isInteger(ownNodeId)
		|| ownNodeId < 1
		|| ownNodeId > CLASSIC_NODE_ID_MAX
	) {
		throw new RangeError(
			"ownNodeId must be a classic Z-Wave node ID (1..232)",
		);
	}
	const includedNodeIds = [
		...new Set(options.includedNodeIds ?? [ownNodeId]),
	];
	if (!includedNodeIds.includes(ownNodeId))
		includedNodeIds.unshift(ownNodeId);
	for (const nodeId of includedNodeIds) {
		if (
			!Number.isInteger(nodeId)
			|| nodeId < 1
			|| nodeId > CLASSIC_NODE_ID_MAX
		) {
			throw new RangeError(
				"includedNodeIds entries must be classic Z-Wave node IDs (1..232)",
			);
		}
	}
	const quarantinedNodeIds = [...(options.quarantinedNodeIds ?? [])];
	if (
		new Set(quarantinedNodeIds).size !== quarantinedNodeIds.length
		|| quarantinedNodeIds.some(
			(nodeId) =>
				!Number.isInteger(nodeId)
				|| nodeId < 1
				|| nodeId > CLASSIC_NODE_ID_MAX
				|| nodeId === ownNodeId
				|| includedNodeIds.includes(nodeId),
		)
	) {
		throw new RangeError(
			"quarantinedNodeIds entries must be unique, uncommitted classic node IDs",
		);
	}
	const nodeChannels = new Map(options.nodeChannels ?? []);
	for (const [nodeId, nodeChannel] of nodeChannels) {
		if (
			!includedNodeIds.includes(nodeId)
			|| nodeId === ownNodeId
			|| !Number.isInteger(nodeChannel)
			|| nodeChannel < 0
			|| nodeChannel > 0xff
		) {
			throw new RangeError(
				"nodeChannels contains an invalid node or channel",
			);
		}
	}
	const nodeNeighbors = new Map<number, readonly number[]>();
	for (const [nodeId, configuredNeighbors] of options.nodeNeighbors ?? []) {
		const neighbors = [...configuredNeighbors];
		if (
			!includedNodeIds.includes(nodeId)
			|| neighbors.some(
				(neighborId) =>
					!includedNodeIds.includes(neighborId)
					|| neighborId === nodeId,
			)
			|| new Set(neighbors).size !== neighbors.length
		) {
			throw new RangeError(
				"nodeNeighbors contains an invalid directed edge",
			);
		}
		nodeNeighbors.set(
			nodeId,
			Object.freeze(neighbors.toSorted((a, b) => a - b)),
		);
	}
	const nodeProtocolInfo = new Map<number, Bytes>();
	for (const [nodeId, configuredProtocolInfo] of options.nodeProtocolInfo
		?? []) {
		if (
			!includedNodeIds.includes(nodeId)
			|| nodeId === ownNodeId
			|| configuredProtocolInfo.length !== 6
		) {
			throw new RangeError(
				"nodeProtocolInfo contains an invalid node or record",
			);
		}
		nodeProtocolInfo.set(nodeId, Bytes.from(configuredProtocolInfo));
	}
	const repeaterNodeIds = new Set(options.repeaterNodeIds ?? []);
	for (const nodeId of repeaterNodeIds) {
		if (nodeId === ownNodeId || !includedNodeIds.includes(nodeId)) {
			throw new RangeError("repeaterNodeIds contains an invalid node");
		}
	}
	const routes = new Map<number, readonly number[]>();
	for (const [destinationNodeId, configuredRepeaters] of options.routes
		?? []) {
		if (
			!Number.isInteger(destinationNodeId)
			|| destinationNodeId < 1
			|| destinationNodeId > CLASSIC_NODE_ID_MAX
			|| destinationNodeId === ownNodeId
			|| !includedNodeIds.includes(destinationNodeId)
			|| !Array.isArray(configuredRepeaters)
			|| configuredRepeaters.length < 1
			|| configuredRepeaters.length > 4
		) {
			throw new RangeError(
				"routes contains an invalid destination or repeater path",
			);
		}
		const repeaters = [...configuredRepeaters];
		if (
			repeaters.some(
				(nodeId) =>
					!Number.isInteger(nodeId)
					|| nodeId < 1
					|| nodeId > CLASSIC_NODE_ID_MAX
					|| nodeId === ownNodeId
					|| nodeId === destinationNodeId
					|| !includedNodeIds.includes(nodeId),
			)
			|| new Set(repeaters).size !== repeaters.length
		) {
			throw new RangeError(
				"routes contains an invalid or duplicate repeater",
			);
		}
		routes.set(destinationNodeId, repeaters);
		for (const repeaterNodeId of repeaters)
			repeaterNodeIds.add(repeaterNodeId);
	}
	const channel = options.channel ?? 0;
	const inclusionChannel = normalizeInclusionChannel(
		options.inclusionChannel,
	);
	if (!Number.isInteger(channel) || channel < 0 || channel > 0xff) {
		throw new RangeError("channel must be an unsigned byte");
	}
	const txPower = options.txPowerDeciDbm;
	if (
		txPower !== undefined
		&& (!Number.isInteger(txPower) || txPower < -0x8000 || txPower > 0x7fff)
	) {
		throw new RangeError("txPowerDeciDbm must be a signed 16-bit value");
	}
	const maxAttempts = options.maxAttempts ?? 3;
	if (maxAttempts < 1 || maxAttempts > 3) {
		throw new RangeError("maxAttempts must be between 1 and 3");
	}
	const controllerNeighborDiscoveryDelayMs =
		options.controllerNeighborDiscoveryDelayMs
		?? CONTROLLER_NEIGHBOR_DISCOVERY_DELAY_MS;
	if (
		!Number.isFinite(controllerNeighborDiscoveryDelayMs)
		|| controllerNeighborDiscoveryDelayMs < 0
		|| controllerNeighborDiscoveryDelayMs
			> CONTROLLER_REPLICATION_TIMEOUT_MS
	) {
		throw new RangeError(
			"controllerNeighborDiscoveryDelayMs must be between 0 and 10000 ms",
		);
	}
	const channelConfiguration =
		options.channelConfiguration ?? ChannelConfiguration.Classic;
	if (channelConfiguration !== ChannelConfiguration.Classic) {
		throw new RangeError(
			"Software controller currently supports classic channels only",
		);
	}
	return {
		region: options.region,
		channelConfiguration,
		homeId: options.homeId,
		ownNodeId,
		channel,
		inclusionChannel,
		txPower,
		maxAttempts,
		cca: options.cca ?? true,
		controllerNeighborDiscoveryDelayMs,
		includedNodeIds,
		quarantinedNodeIds,
		nodeChannels,
		nodeNeighbors,
		nodeProtocolInfo,
		repeaterNodeIds,
		routes,
	};
}

function protocolInfoFromNIF(
	nifPayload: BytesView,
	nodeInformation: NodeInformationFrame,
): Bytes {
	if (nifPayload.length < 5) {
		throw new Error(
			"Node information frame is too short for protocol info",
		);
	}
	return Bytes.concat([
		nifPayload.subarray(0, 3),
		[
			nodeInformation.basicDeviceClass,
			nodeInformation.genericDeviceClass,
			nodeInformation.specificDeviceClass,
		],
	]);
}

function beamModeFromProtocolInfo(
	protocolInfo: BytesView | undefined,
): SoftwareControllerBeamMode | undefined {
	if (!protocolInfo || protocolInfo.length !== 6) return undefined;
	switch (protocolInfo[1] & 0x60) {
		case 0x20:
			return BEAM_MODE_SHORT;
		case 0x40:
			return BEAM_MODE_LONG;
		default:
			return undefined;
	}
}

function isClassicDataRate(rate: ProtocolDataRate): boolean {
	return (
		rate === ProtocolDataRate.ZWave_9k6
		|| rate === ProtocolDataRate.ZWave_40k
		|| rate === ProtocolDataRate.ZWave_100k
	);
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function destinationNodeId(mpdu: MPDU): number | undefined {
	if (mpdu instanceof MulticastZWaveMPDU) return undefined;
	if (mpdu instanceof SinglecastZWaveMPDU) return mpdu.destinationNodeId;
	if (mpdu instanceof RoutedZWaveMPDU) return mpdu.destinationNodeId;
	if (mpdu instanceof LongRangeMPDU) return mpdu.destinationNodeId;
	if (mpdu instanceof ExplorerZWaveMPDU) return mpdu.destinationNodeId;
	return undefined;
}

/**
 * Classic Z-Wave controller using an injected radio with hardware-local ACK,
 * bounded retry and optional atomic beam support. Network membership, Protocol
 * CC inclusion/replication, routing and MPDU serialization remain on the host.
 */
export class SoftwareController implements RawControllerTransport {
	public readonly maximumPayloadSize: number;
	readonly #options: SoftwareControllerOptions;
	readonly #normalized: NormalizedOptions;
	readonly #radio: SoftwareControllerRadio;
	readonly #includedNodeIds: Set<number>;
	readonly #quarantinedNodeIds = new Set<number>();
	readonly #nodeChannels = new Map<number, number>();
	readonly #nodeNeighbors = new Map<number, readonly number[]>();
	readonly #nodeProtocolInfo = new Map<number, Bytes>();
	readonly #flirsAwakeUntil = new Map<number, number>();
	readonly #repeaterNodeIds = new Set<number>();
	readonly #routes = new Map<number, readonly number[]>();
	readonly #directNeighborNodeIds = new Set<number>();
	#regionConfig: SoftwareControllerRegionConfig | undefined;
	#onFrame: ((frame: ControllerApplicationFrame) => void) | undefined;
	#networkManagementSession: NetworkManagementSession | undefined;
	#protocolCommandWaiter: ProtocolCommandWaiter | undefined;
	#explorerResultWaiter: ExplorerResultWaiter | undefined;
	#sequenceNumber: number | undefined;
	#sendInFlight = false;
	#activeSend: Promise<unknown> | undefined;
	#nodeInformationRequest: NodeInformationRequest | undefined;
	readonly #applicationResponseWindow = new ApplicationResponseWindow(() =>
		this.#expireApplicationResponseWindow(),
	);
	#persistenceTail: Promise<void> = Promise.resolve();
	#persistenceError: { error: unknown } | undefined;
	#stopOperation: Promise<void> | undefined;
	readonly #startupCleanupErrors: unknown[] = [];
	#factoryDefaultOperation: Promise<ControllerIdentity> | undefined;
	#networkStateEpoch = 0;
	#faulted = false;
	#started = false;

	public constructor(options: SoftwareControllerOptions) {
		this.#options = options;
		this.#normalized = normalizeOptions(options);
		this.#includedNodeIds = new Set(this.#normalized.includedNodeIds);
		for (const nodeId of this.#normalized.quarantinedNodeIds) {
			this.#quarantinedNodeIds.add(nodeId);
		}
		for (const entry of this.#normalized.nodeChannels) {
			this.#nodeChannels.set(...entry);
		}
		for (const [nodeId, neighbors] of this.#normalized.nodeNeighbors) {
			this.#nodeNeighbors.set(nodeId, Object.freeze([...neighbors]));
		}
		for (const [nodeId, protocolInfo] of this.#normalized
			.nodeProtocolInfo) {
			this.#nodeProtocolInfo.set(nodeId, Bytes.from(protocolInfo));
		}
		for (const nodeId of this.#normalized.repeaterNodeIds) {
			this.#repeaterNodeIds.add(nodeId);
		}
		for (const [nodeId, route] of this.#normalized.routes) {
			this.#routes.set(nodeId, Object.freeze([...route]));
		}
		this.#radio = options.radioFactory();
		const { maximumMPDUSize, maximumBeamMPDUSize } = this.#radio.limits;
		if (
			!Number.isInteger(maximumMPDUSize)
			|| maximumMPDUSize > 0xff
			|| !Number.isInteger(maximumBeamMPDUSize)
			|| maximumBeamMPDUSize < 0
			|| maximumBeamMPDUSize > 0xff
		) {
			throw new RangeError("Radio MPDU limits must be unsigned bytes");
		}
		// A four-repeater FLiRS route uses 17 bytes; Driver adds eight bytes to
		// the advertised Explorer base. Reserve 13 bytes for a direct beam MPDU.
		this.maximumPayloadSize =
			Math.min(
				maximumMPDUSize - 17,
				maximumBeamMPDUSize > 0 ? maximumBeamMPDUSize - 13 : Infinity,
			) - 8;
		if (
			!Number.isInteger(this.maximumPayloadSize)
			|| this.maximumPayloadSize < 1
			|| this.maximumPayloadSize > 0xff
		) {
			throw new RangeError(
				"Radio MPDU limit cannot support Classic controller payloads",
			);
		}
		if (options.onControllerStateChanged) {
			this.factoryDefault = () => this.#resetToFactoryDefaults();
		}
	}

	/** Advertised only when an atomic persistence callback was configured. */
	public readonly factoryDefault?: () => Promise<ControllerIdentity>;

	async #resetToFactoryDefaults(): Promise<ControllerIdentity> {
		if (this.#factoryDefaultOperation) {
			throw new Error("Controller factory-default is already active");
		}
		this.#applicationResponseWindow.cancel();
		// Defer the implementation by one microtask so the operation fence is
		// visible before any cancellation or I/O can run.
		const operation = Promise.resolve().then(() =>
			this.#performFactoryDefault(),
		);
		this.#factoryDefaultOperation = operation;
		this.#networkStateEpoch++;
		try {
			return await operation;
		} finally {
			if (this.#factoryDefaultOperation === operation) {
				this.#factoryDefaultOperation = undefined;
			}
		}
	}

	async #performFactoryDefault(): Promise<ControllerIdentity> {
		this.#nodeInformationRequest?.cancel();
		await this.#cancelNetworkManagementForFactoryDefault();
		await this.#activeSend?.catch((error) => this.#reportError(error));
		if (this.#networkManagementSession || this.#sendInFlight) {
			throw new Error(
				"Controller network activity did not quiesce for factory-default",
			);
		}
		const radio = this.#requireManagementRadio();

		const previousState = this.#controllerStateSnapshot();
		let homeId: number | undefined;
		for (let attempt = 0; attempt < 16; attempt++) {
			const candidate = generateRandomHomeId();
			if (candidate !== this.#normalized.homeId) {
				homeId = candidate;
				break;
			}
		}
		if (homeId === undefined) {
			throw new Error(
				"Factory-default Home ID generator did not produce a fresh identity",
			);
		}
		const nextState = this.#emptyControllerStateSnapshot(homeId);

		// Reuse the transmit exclusion flag as the transport-wide operation lock.
		// All normal MAC and network-management entry points already honor it.
		this.#sendInFlight = true;
		let persistenceAttempted = false;
		try {
			// MAC configuration is volatile. Disable filtering/auto-ACK while the
			// identity changes, then install the candidate identity as one radio operation.
			await this.#configure(radio, "disabled");
			await this.#configure(radio, "network", homeId, 1);
			persistenceAttempted = true;
			await this.#persistControllerState(nextState);

			// No fallible work remains after the atomic persistence commit.
			this.#normalized.homeId = homeId;
			this.#normalized.ownNodeId = 1;
			this.#includedNodeIds.clear();
			this.#includedNodeIds.add(1);
			this.#quarantinedNodeIds.clear();
			this.#nodeChannels.clear();
			this.#nodeNeighbors.clear();
			this.#nodeProtocolInfo.clear();
			this.#repeaterNodeIds.clear();
			this.#routes.clear();
			this.#directNeighborNodeIds.clear();
			this.#flirsAwakeUntil.clear();
			this.#sequenceNumber = undefined;
			this.#rejectProtocolCommandWaiter(
				new Error("Controller was reset to factory defaults"),
			);
			this.#rejectExplorerResultWaiter(
				new Error("Controller was reset to factory defaults"),
			);
			this.#diagnostic(
				`Controller reset to factory defaults with Home ID 0x${homeId.toString(16).padStart(8, "0")} and node ID 1`,
			);
			return { homeId, ownNodeId: 1 };
		} catch (error) {
			const rollbackErrors: unknown[] = [];
			if (persistenceAttempted) {
				try {
					await this.#persistControllerState(previousState);
				} catch (rollbackError) {
					rollbackErrors.push(rollbackError);
				}
			}
			try {
				await this.#configure(
					radio,
					"network",
					previousState.homeId,
					previousState.ownNodeId,
				);
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
			}
			if (rollbackErrors.length > 0) {
				this.#faulted = true;
				throw new AggregateError(
					[error, ...rollbackErrors],
					"Controller factory-default failed and rollback was incomplete",
				);
			}
			throw error;
		} finally {
			this.#sendInFlight = false;
		}
	}

	async #cancelNetworkManagementForFactoryDefault(): Promise<void> {
		const session = this.#networkManagementSession;
		if (!session) return;

		session.stopping = true;
		this.#stopTransferPresentation(session);
		if (session.kind === "inclusion") {
			this.#rejectInclusionWaiter(
				session,
				new Error(
					"Inclusion was cancelled by controller factory-default",
				),
			);
		}
		await session.ready.catch(() => undefined);
		await session.operation?.catch(() => undefined);
		if (this.#networkManagementSession === session) {
			this.#networkManagementSession = undefined;
		}
	}

	public readonly networkManagement: ControllerNetworkManagement = {
		beginInclusion: (request, onEvent) =>
			this.#beginInclusion(request, onEvent),
		stopInclusion: () => this.#stopInclusion(),
		beginExclusion: (request, onEvent) =>
			this.#beginExclusion(request, onEvent),
		stopExclusion: () => this.#stopExclusion(),
	};

	public getNodeNeighbors(
		request: ControllerRoutingInfoRequest,
	): readonly number[] {
		if (!this.#includedNodeIds.has(request.nodeId)) return [];
		const neighbors = new Set(
			this.#nodeNeighbors.get(request.nodeId) ?? [],
		);
		if (request.nodeId === this.#normalized.ownNodeId) {
			for (const nodeId of this.#directNeighborNodeIds)
				neighbors.add(nodeId);
		} else if (this.#directNeighborNodeIds.has(request.nodeId)) {
			neighbors.add(this.#normalized.ownNodeId);
		}
		return [...neighbors]
			.filter(
				(nodeId) =>
					this.#includedNodeIds.has(nodeId)
					&& (!request.removeNonRepeaters
						|| nodeId === this.#normalized.ownNodeId
						|| this.#repeaterNodeIds.has(nodeId)),
			)
			.toSorted((left, right) => left - right);
	}

	public getNodeProtocolInfo(nodeId: number): BytesView | undefined {
		if (!this.#includedNodeIds.has(nodeId)) return undefined;
		if (nodeId === this.#normalized.ownNodeId) {
			// Always listening, routing controller. Advertise TX beaming only after
			// the radio has negotiated the physically implemented capability.
			return Bytes.from([
				0xdb,
				0x82 | (this.#radio.capabilities.beamTx ? 0x10 : 0),
				0x01,
				0x02,
				0x01,
				0x00,
			]);
		}
		const protocolInfo = this.#nodeProtocolInfo.get(nodeId);
		return protocolInfo ? Bytes.from(protocolInfo) : undefined;
	}

	public async updateNodeNeighbors(nodeId: number): Promise<boolean> {
		const networkStateEpoch = this.#networkStateEpoch;
		if (
			!this.#started
			|| !this.#regionConfig
			|| this.#networkManagementSession
			|| this.#sendInFlight
			|| this.#factoryDefaultOperation
			|| nodeId === this.#normalized.ownNodeId
			|| !this.#includedNodeIds.has(nodeId)
		)
			return false;

		const candidateNodeIds = [...this.#includedNodeIds]
			.filter((candidateNodeId) => candidateNodeId !== nodeId)
			.toSorted((left, right) => left - right);
		const candidateMask = this.#nodeMask(candidateNodeIds);
		const channel =
			this.#nodeChannels.get(nodeId) ?? this.#normalized.channel;
		const findResult = await this.send({
			destinationNodeId: nodeId,
			command: Bytes.concat([
				[
					PROTOCOL_CC,
					PROTOCOL_FIND_NODES_IN_RANGE,
					0x80 | candidateMask.length,
				],
				candidateMask,
				[0x00, this.#replicationDataRate(channel)],
			]),
			transmitOptions: TRANSMIT_OPTION_ACK,
		});
		if (findResult.status !== ControllerTransmitStatus.OK) return false;
		await wait(this.#normalized.controllerNeighborDiscoveryDelayMs);
		if (networkStateEpoch !== this.#networkStateEpoch) return false;

		const response = this.#waitForProtocolCommand(
			nodeId,
			(command) =>
				this.#isProtocolCommand(command, PROTOCOL_RANGE_INFO)
				&& command.length >= 3
				&& command.length >= 3 + (command[2] & 0x1f),
			NODE_NEIGHBOR_UPDATE_TIMEOUT_MS,
		);
		const getResult = await this.send({
			destinationNodeId: nodeId,
			command: Bytes.from([PROTOCOL_CC, PROTOCOL_GET_NODES_IN_RANGE]),
			transmitOptions: TRANSMIT_OPTION_ACK,
		});
		if (getResult.status !== ControllerTransmitStatus.OK) {
			this.#rejectProtocolCommandWaiter(
				new Error("Get Nodes In Range was not acknowledged"),
			);
			await response.catch(() => undefined);
			return false;
		}
		let command: Bytes;
		try {
			command = await response;
		} catch {
			return false;
		}
		if (networkStateEpoch !== this.#networkStateEpoch) return false;
		const maskLength = command[2] & 0x1f;
		const neighbors: number[] = [];
		for (let byteIndex = 0; byteIndex < maskLength; byteIndex++) {
			const value = command[3 + byteIndex];
			for (let bit = 0; bit < 8; bit++) {
				const neighborId = byteIndex * 8 + bit + 1;
				if (
					(value & (1 << bit)) !== 0
					&& neighborId !== nodeId
					&& this.#includedNodeIds.has(neighborId)
				)
					neighbors.push(neighborId);
			}
		}
		this.#nodeNeighbors.set(nodeId, Object.freeze(neighbors));
		await this.#persistControllerState();
		return true;
	}

	public async assignReturnRoutes(
		request: ControllerReturnRouteRequest,
	): Promise<ControllerTransmitResult> {
		const networkStateEpoch = this.#networkStateEpoch;
		if (
			!this.#started
			|| !this.#regionConfig
			|| this.#networkManagementSession
			|| this.#sendInFlight
			|| this.#factoryDefaultOperation
			|| request.sourceNodeId === this.#normalized.ownNodeId
			|| request.sourceNodeId === request.destinationNodeId
			|| !this.#includedNodeIds.has(request.sourceNodeId)
			|| !this.#includedNodeIds.has(request.destinationNodeId)
		)
			return { status: ControllerTransmitStatus.NotIdle };

		const routes = findRoutes(
			request.sourceNodeId,
			request.destinationNodeId,
			{
				neighbors: this.#nodeNeighbors,
				repeaters: this.#repeaterNodeIds,
			},
			MAX_RETURN_ROUTES,
		);
		if (routes.length === 0) {
			return { status: ControllerTransmitStatus.NoRoute };
		}

		for (let routeIndex = 0; routeIndex < MAX_RETURN_ROUTES; routeIndex++) {
			if (networkStateEpoch !== this.#networkStateEpoch) {
				return { status: ControllerTransmitStatus.NotIdle };
			}
			const route = routes[routeIndex];
			const result = await this.#sendReturnRouteSlot(
				request.sourceNodeId,
				routeIndex,
				route ? request.destinationNodeId : 0,
				route ?? [],
			);
			if (result.status !== ControllerTransmitStatus.OK) return result;
		}
		return { status: ControllerTransmitStatus.OK };
	}

	public async deleteReturnRoutes(
		sourceNodeId: number,
	): Promise<ControllerTransmitResult> {
		const networkStateEpoch = this.#networkStateEpoch;
		if (
			!this.#started
			|| !this.#regionConfig
			|| this.#networkManagementSession
			|| this.#sendInFlight
			|| this.#factoryDefaultOperation
			|| sourceNodeId === this.#normalized.ownNodeId
			|| !this.#includedNodeIds.has(sourceNodeId)
		)
			return { status: ControllerTransmitStatus.NotIdle };

		for (let routeIndex = 0; routeIndex < MAX_RETURN_ROUTES; routeIndex++) {
			if (networkStateEpoch !== this.#networkStateEpoch) {
				return { status: ControllerTransmitStatus.NotIdle };
			}
			const result = await this.#sendReturnRouteSlot(
				sourceNodeId,
				routeIndex,
				0,
				[],
			);
			if (result.status !== ControllerTransmitStatus.OK) return result;
		}
		return { status: ControllerTransmitStatus.OK };
	}

	async #sendReturnRouteSlot(
		sourceNodeId: number,
		routeIndex: number,
		destinationNodeId: number,
		repeaters: readonly number[],
	): Promise<ControllerTransmitResult> {
		const channel =
			this.#nodeChannels.get(destinationNodeId)
			?? this.#nodeChannels.get(sourceNodeId)
			?? this.#normalized.channel;
		const beamMode = beamModeFromProtocolInfo(
			this.#nodeProtocolInfo.get(destinationNodeId),
		);
		// Assign Return Route uses its own wake-up enumeration (NWK Table 4.22),
		// which is the reverse of Find Nodes In Range: 1=250 ms, 2=1000 ms.
		const destinationWakeUp =
			beamMode === BEAM_MODE_SHORT
				? 0x01
				: beamMode === BEAM_MODE_LONG
					? 0x02
					: 0x00;
		const speedAndWakeUp =
			(this.#returnRouteDestinationSpeed(channel) << 3)
			| (destinationWakeUp << 1);
		return this.send({
			destinationNodeId: sourceNodeId,
			command: Bytes.from([
				PROTOCOL_CC,
				PROTOCOL_ASSIGN_RETURN_ROUTE,
				destinationNodeId,
				(routeIndex << 4) | repeaters.length,
				...repeaters,
				speedAndWakeUp,
			]),
			transmitOptions: TRANSMIT_OPTION_ACK,
		});
	}

	public get firmwareInfo(): ControllerFirmwareInfo | undefined {
		if (!this.#started || this.#faulted) return undefined;
		const info = this.#radio.firmwareInfo;
		return info ? { ...info } : undefined;
	}

	public async start(
		onFrame: (frame: ControllerApplicationFrame) => void,
	): Promise<void> {
		await this.#stopOperation;
		if (this.#persistenceError) throw this.#persistenceError.error;
		if (this.#startupCleanupErrors.length > 0) {
			throw new AggregateError(
				this.#startupCleanupErrors,
				"Software controller startup cleanup failed",
			);
		}
		if (this.#started)
			throw new Error("Software controller is already started");
		this.#stopOperation = undefined;
		this.#started = true;
		this.#directNeighborNodeIds.clear();
		this.#onFrame = onFrame;
		try {
			const regionConfig = await this.#radio.start(
				this.#handleMPDU,
				this.#handleRadioError,
			);
			if (
				regionConfig.region !== this.#normalized.region
				|| regionConfig.channelConfig
					!== this.#normalized.channelConfiguration
			) {
				throw new Error("Radio did not retain the requested RF region");
			}
			const capabilities = this.#radio.capabilities;
			if (
				capabilities.beamTx
				&& this.#radio.limits.maximumBeamMPDUSize === 0
			) {
				throw new Error(
					"Radio negotiated beaming without a beam MPDU limit",
				);
			}
			if (
				!capabilities.localAck
				|| !capabilities.localTransmitAck
				|| !capabilities.explorerTargetReply
				|| !capabilities.routedAckStatus
			) {
				throw new Error(
					"Radio lacks hardware-local Classic MAC capabilities",
				);
			}
			const channel = regionConfig.channels.find(
				(candidate) => candidate.channel === this.#normalized.channel,
			);
			if (!channel || !isClassicDataRate(channel.dataRate)) {
				throw new Error(
					`Radio channel ${this.#normalized.channel} is not a classic Z-Wave channel`,
				);
			}
			if (this.#normalized.inclusionChannel !== undefined) {
				const inclusionChannel = regionConfig.channels.find(
					(candidate) =>
						candidate.channel === this.#normalized.inclusionChannel,
				);
				if (
					!inclusionChannel
					|| !isClassicDataRate(inclusionChannel.dataRate)
				) {
					throw new Error(
						`Inclusion channel ${this.#normalized.inclusionChannel} is not a classic Z-Wave channel`,
					);
				}
			}
			for (const nodeChannel of this.#nodeChannels.values()) {
				if (
					!regionConfig.channels.some(
						(candidate) =>
							candidate.channel === nodeChannel
							&& isClassicDataRate(candidate.dataRate),
					)
				) {
					throw new Error(
						`Persisted node channel ${nodeChannel} is not available in the configured region`,
					);
				}
			}

			this.#regionConfig = regionConfig;
			await this.#configure(this.#radio, "network");
			this.#faulted = false;
		} catch (error) {
			this.#reportError(error);
			await this.#radio.stop().catch((closeError) => {
				this.#startupCleanupErrors.push(closeError);
				this.#reportError(closeError);
			});
			this.#regionConfig = undefined;
			this.#started = false;
			this.#onFrame = undefined;
			throw error;
		}
	}

	public stop(): Promise<void> {
		return (this.#stopOperation ??= this.#stop());
	}

	async #stop(): Promise<void> {
		this.#applicationResponseWindow.cancel();
		if (!this.#started) {
			await this.#persistenceTail;
			const errors = [...this.#startupCleanupErrors];
			if (this.#persistenceError)
				errors.push(this.#persistenceError.error);
			if (errors.length > 0) {
				throw new AggregateError(
					errors,
					"Software controller could not be stopped safely",
				);
			}
			return;
		}
		const errors: unknown[] = [];
		const collectError = (error: unknown): void => {
			if (!errors.includes(error)) errors.push(error);
			this.#reportError(error);
		};
		await this.#factoryDefaultOperation?.catch(collectError);
		if (this.#networkManagementSession?.kind === "inclusion") {
			await this.#stopInclusion().catch(collectError);
		} else if (this.#networkManagementSession?.kind === "exclusion") {
			await this.#stopExclusion().catch(collectError);
		}
		this.#nodeInformationRequest?.cancel();
		this.#started = false;
		const radio = this.#radio;
		try {
			await this.#activeSend?.catch(collectError);
			await radio.stop().catch(collectError);

			// Channel learning may originate from a receive callback. Drain the
			// serialized save queue before completing shutdown so the newest PHY
			// snapshot cannot be lost or overtaken by an older write.
			await this.#persistenceTail;
			if (this.#persistenceError) {
				collectError(this.#persistenceError.error);
			}
		} finally {
			this.#regionConfig = undefined;
			this.#onFrame = undefined;
			this.#networkManagementSession = undefined;
			this.#rejectProtocolCommandWaiter(
				new Error("Software controller stopped"),
			);
			this.#rejectExplorerResultWaiter(
				new Error("Software controller stopped"),
			);
			this.#sendInFlight = false;
			this.#activeSend = undefined;
			this.#faulted = false;
			this.#flirsAwakeUntil.clear();
		}
		if (errors.length > 0) {
			throw new AggregateError(
				errors,
				"Software controller could not be stopped safely",
			);
		}
	}

	public async requestNodeInformation(
		nodeId: number,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<ControllerApplicationFrame | undefined> {
		if (
			!this.#started
			|| !this.#regionConfig
			|| this.#faulted
			|| this.#sendInFlight
			|| this.#networkManagementSession
			|| this.#factoryDefaultOperation
			|| !this.#includedNodeIds.has(nodeId)
			|| nodeId === this.#normalized.ownNodeId
			|| signal?.aborted
		)
			return;
		const pending = new NodeInformationRequest(nodeId, timeoutMs, signal);
		this.#nodeInformationRequest = pending;
		this.#sendInFlight = true;
		const operation = this.#requestNodeInformation(pending);
		this.#activeSend = operation;
		try {
			return await operation;
		} finally {
			this.#sendInFlight = false;
			if (this.#activeSend === operation) this.#activeSend = undefined;
		}
	}

	async #requestNodeInformation(
		pending: NodeInformationRequest,
	): Promise<ControllerApplicationFrame | undefined> {
		let frame: ControllerApplicationFrame | undefined;
		let failure: { error: unknown } | undefined;
		try {
			const result = await this.#sendAcrossClassicChannels(
				{
					destinationNodeId: pending.nodeId,
					command: Uint8Array.of(0x01, 0x02),
					transmitOptions: 0,
				},
				true,
			);
			if (result.status === ControllerTransmitStatus.OK)
				frame = await pending.response;
		} catch (error) {
			failure = { error };
		}
		pending.cancel();
		try {
			// A response must not reach the Driver until hopping is restored
			// and the operation fence can release its next interview command.
			await this.#configure(
				this.#radio,
				!this.#started || this.#faulted || this.#factoryDefaultOperation
					? "disabled"
					: "network",
			);
		} catch (error) {
			this.#handleRadioError(error);
			if (failure) {
				throw new AggregateError(
					[...new Set([failure.error, error])],
					"Node information request and receiver cleanup failed",
				);
			}
			throw error;
		} finally {
			if (this.#nodeInformationRequest === pending)
				this.#nodeInformationRequest = undefined;
		}
		if (failure) throw failure.error;
		return frame;
	}

	public async send(
		request: ControllerTransmitRequest,
	): Promise<ControllerTransmitResult> {
		if (!this.#regionConfig || !this.#started) {
			throw new Error("Software controller is not started");
		}
		if (this.#faulted) return { status: ControllerTransmitStatus.Fail };
		if (
			this.#sendInFlight
			|| this.#networkManagementSession
			|| this.#factoryDefaultOperation
		) {
			return { status: ControllerTransmitStatus.NotIdle };
		}
		if (
			request.destinationNodeId < 1
			|| (request.destinationNodeId > CLASSIC_NODE_ID_MAX
				&& request.destinationNodeId !== NODE_ID_BROADCAST)
		) {
			return { status: ControllerTransmitStatus.Fail };
		}
		if (this.#quarantinedNodeIds.has(request.destinationNodeId)) {
			this.#diagnostic(
				`Refusing application traffic to quarantined node ID ${request.destinationNodeId}`,
			);
			return { status: ControllerTransmitStatus.Fail };
		}

		this.#sendInFlight = true;
		const operation = this.#sendAcrossClassicChannels(request, false, true);
		this.#activeSend = operation;
		try {
			return await operation;
		} finally {
			this.#sendInFlight = false;
			if (this.#activeSend === operation) this.#activeSend = undefined;
		}
	}

	async #sendAcrossClassicChannels(
		request: ControllerTransmitRequest,
		holdRx = false,
		applicationResponse = false,
	): Promise<ControllerTransmitResult> {
		const flirsBeamMode = beamModeFromProtocolInfo(
			this.#nodeProtocolInfo.get(request.destinationNodeId),
		);
		const beamMode = this.#requiredBeamMode(request.destinationNodeId);
		if (beamMode && (request.transmitOptions & TRANSMIT_OPTION_ACK) === 0) {
			this.#diagnostic(
				`Refusing unacknowledged delivery to sleeping FLiRS node ${request.destinationNodeId}`,
			);
			return { status: ControllerTransmitStatus.Fail };
		}
		const knownChannel = this.#nodeChannels.get(request.destinationNodeId);
		const routeCandidates = this.#outboundRouteCandidates(
			request.destinationNodeId,
		);
		const selectedRoute = beamMode
			? routeCandidates.find((route) => {
					const lastRepeater = route.at(-1);
					return (
						lastRepeater !== undefined
						&& this.#nodeSupportsBeaming(lastRepeater)
					);
				})
			: routeCandidates[0];
		const directBeamRequired =
			beamMode !== undefined && selectedRoute === undefined;
		// FLiRS traffic is R2/40 kbit/s on every hop. This also applies while the
		// two-second awake window lets us omit a new beam, and when a final repeater
		// performs the destination beam for a routed frame.
		const beamChannel = flirsBeamMode
			? this.#regionConfig!.channels.find(
					(candidate) =>
						candidate.dataRate === ProtocolDataRate.ZWave_40k,
				)?.channel
			: undefined;
		if (flirsBeamMode && beamChannel === undefined) {
			this.#diagnostic(
				`Node ${request.destinationNodeId} is FLiRS, but this region has no Classic R2/40 kbit/s channel`,
			);
			return { status: ControllerTransmitStatus.NoRoute };
		}
		if (directBeamRequired && !this.#radio.capabilities.beamTx) {
			this.#diagnostic(
				`Node ${request.destinationNodeId} is FLiRS, but the radio has no negotiated beam capability`,
			);
			return { status: ControllerTransmitStatus.Fail };
		}
		const initialChannel =
			beamChannel ?? knownChannel ?? this.#normalized.channel;
		if (beamMode && routeCandidates.length > 0 && !selectedRoute) {
			this.#diagnostic(
				`Ignoring routes to FLiRS node ${request.destinationNodeId} because their final repeater cannot issue wake-up beams`,
			);
		}
		let result = await this.#performSend(
			request,
			initialChannel,
			this.#normalized.homeId,
			holdRx,
			false,
			selectedRoute ?? (beamMode ? null : undefined),
			beamMode ?? null,
			false,
			applicationResponse,
		);
		if (flirsBeamMode) {
			if (
				result.status === ControllerTransmitStatus.OK
				&& knownChannel !== initialChannel
			) {
				void this.#rememberNodeChannel(
					request.destinationNodeId,
					initialChannel,
				);
			}
			if (
				selectedRoute
				&& result.status === ControllerTransmitStatus.OK
			) {
				this.#rememberWorkingRoute(
					request.destinationNodeId,
					selectedRoute,
				);
			}
			if (
				result.status === ControllerTransmitStatus.OK
				&& (request.transmitOptions & TRANSMIT_OPTION_ACK) !== 0
			) {
				this.#markFlirsAwake(request.destinationNodeId);
			} else if (result.status !== ControllerTransmitStatus.OK) {
				// An unacknowledged plain follow-up is stronger evidence than the
				// optimistic two-second hold timer. The next attempt must beam again.
				this.#flirsAwakeUntil.delete(request.destinationNodeId);
			}
			this.#rememberAcknowledgedDirectLink(request, result);
			return result;
		}
		const isSafeChannelProbe =
			request.command.length === 1
			&& request.command[0] === 0x00
			&& (request.transmitOptions & TRANSMIT_OPTION_ACK) !== 0;
		if (
			!isSafeChannelProbe
			|| result.status !== ControllerTransmitStatus.NoAck
		) {
			if (
				selectedRoute
				&& result.status === ControllerTransmitStatus.OK
			) {
				this.#rememberWorkingRoute(
					request.destinationNodeId,
					selectedRoute,
				);
			}
			if (
				knownChannel === undefined
				&& result.status === ControllerTransmitStatus.OK
			) {
				void this.#rememberNodeChannel(
					request.destinationNodeId,
					initialChannel,
				);
			}
			this.#rememberAcknowledgedDirectLink(request, result);
			return result;
		}

		// A NOP is idempotent, so alternate evidence-backed paths can be tried
		// without risking a duplicated application command. Never apply this
		// fallback to a real command: a lost routed ACK is not proof that the node
		// did not execute the command.
		for (const alternativeRoute of routeCandidates.slice(1)) {
			result = await this.#performSend(
				request,
				initialChannel,
				this.#normalized.homeId,
				false,
				false,
				alternativeRoute,
			);
			if (result.status === ControllerTransmitStatus.OK) {
				this.#rememberWorkingRoute(
					request.destinationNodeId,
					alternativeRoute,
				);
				return result;
			}
			if (result.status !== ControllerTransmitStatus.NoAck) return result;
		}
		if (selectedRoute) {
			this.#diagnostic(
				`Routed NOP to node ${request.destinationNodeId} was not acknowledged; trying a direct probe`,
			);
			result = await this.#performSend(
				request,
				initialChannel,
				this.#normalized.homeId,
				false,
				false,
				null,
			);
			this.#rememberAcknowledgedDirectLink(request, result);
			if (result.status !== ControllerTransmitStatus.NoAck) return result;
		}

		// Version-1 state did not persist the learned PHY. A NOP is idempotent,
		// so it is safe to locate a legacy node without risking duplicate app
		// commands on multiple channels.
		for (const candidate of this.#regionConfig!.channels) {
			if (
				candidate.channel === initialChannel
				|| !isClassicDataRate(candidate.dataRate)
			)
				continue;
			result = await this.#performSend(
				request,
				candidate.channel,
				this.#normalized.homeId,
				false,
				false,
				null,
			);
			if (result.status === ControllerTransmitStatus.OK) {
				this.#rememberAcknowledgedDirectLink(request, result);
				void this.#rememberNodeChannel(
					request.destinationNodeId,
					candidate.channel,
				);
				return result;
			}
			if (result.status !== ControllerTransmitStatus.NoAck) return result;
		}
		if (
			result.status === ControllerTransmitStatus.NoAck
			&& (request.transmitOptions & TRANSMIT_OPTION_EXPLORE) !== 0
			&& this.#radio.capabilities.explorerTx
		) {
			this.#diagnostic(
				`Known paths to node ${request.destinationNodeId} failed; trying an Explorer NOP`,
			);
			return this.#performExplorerProbe(request, initialChannel);
		}
		return result;
	}

	#outboundRouteCandidates(
		destinationNodeId: number,
	): readonly (readonly number[])[] {
		const candidates: Array<readonly number[]> = [];
		const active = this.#routes.get(destinationNodeId);
		if (active) candidates.push(active);
		const discovered = findRoutes(
			this.#normalized.ownNodeId,
			destinationNodeId,
			{
				neighbors: this.#nodeNeighbors,
				repeaters: this.#repeaterNodeIds,
			},
		);
		for (const route of discovered) {
			if (
				route.length > 0
				&& !candidates.some(
					(candidate) =>
						candidate.length === route.length
						&& candidate.every(
							(nodeId, index) => nodeId === route[index],
						),
				)
			)
				candidates.push(route);
		}
		return candidates;
	}

	#nodeSupportsBeaming(nodeId: number): boolean {
		const protocolInfo = this.#nodeProtocolInfo.get(nodeId);
		return protocolInfo?.length === 6 && (protocolInfo[1] & 0x10) !== 0;
	}

	#requiredBeamMode(nodeId: number): SoftwareControllerBeamMode | undefined {
		const beamMode = beamModeFromProtocolInfo(
			this.#nodeProtocolInfo.get(nodeId),
		);
		if (!beamMode) return undefined;
		const awakeUntil = this.#flirsAwakeUntil.get(nodeId) ?? 0;
		// Do not launch a plain frame at the edge of the device's guaranteed
		// awake period. Leave room for CCA, routed forwarding and MAC retries.
		if (awakeUntil > Date.now() + FLIRS_AWAKE_TX_GUARD_MS) return undefined;
		this.#flirsAwakeUntil.delete(nodeId);
		return beamMode;
	}

	#markFlirsAwake(nodeId: number): void {
		if (!beamModeFromProtocolInfo(this.#nodeProtocolInfo.get(nodeId)))
			return;
		this.#flirsAwakeUntil.set(nodeId, Date.now() + FLIRS_AWAKE_HOLD_MS);
	}

	#rememberWorkingRoute(
		destinationNodeId: number,
		route: readonly number[],
	): void {
		let topologyChanged = 0;
		const path = [this.#normalized.ownNodeId, ...route, destinationNodeId];
		for (let index = 0; index + 1 < path.length; index++) {
			const sourceNodeId = path[index];
			const nextNodeId = path[index + 1];
			// A final routed ACK proves that this exact path worked in both
			// directions, so both directed edges are safe topology evidence.
			topologyChanged |= this.#rememberDirectedNeighbor(
				sourceNodeId,
				nextNodeId,
			);
			topologyChanged |= this.#rememberDirectedNeighbor(
				nextNodeId,
				sourceNodeId,
			);
		}
		const current = this.#routes.get(destinationNodeId);
		if (
			current
			&& current.length === route.length
			&& current.every((nodeId, index) => nodeId === route[index])
		) {
			if (!topologyChanged) return;
		} else {
			this.#routes.set(destinationNodeId, Object.freeze([...route]));
		}
		void this.#persistControllerState().catch((error) =>
			this.#reportError(error),
		);
	}

	async #runSend(
		request: ControllerTransmitRequest,
		channel: number,
		homeId = this.#normalized.homeId,
		holdRx = false,
		alternateRx = false,
		destinationBeamModeOverride?: SoftwareControllerBeamMode | null,
		routeOverride?: readonly number[] | null,
		speedModified = false,
		radioOptions?: SoftwareControllerRadioTransmitOptions,
	): Promise<ControllerTransmitResult> {
		if (this.#sendInFlight || this.#factoryDefaultOperation) {
			return { status: ControllerTransmitStatus.NotIdle };
		}
		this.#sendInFlight = true;
		const operation = this.#performSend(
			request,
			channel,
			homeId,
			holdRx,
			alternateRx,
			routeOverride,
			destinationBeamModeOverride,
			speedModified,
			false,
			radioOptions,
		);
		this.#activeSend = operation;
		try {
			return await operation;
		} finally {
			this.#sendInFlight = false;
			if (this.#activeSend === operation) this.#activeSend = undefined;
		}
	}

	async #performSend(
		request: ControllerTransmitRequest,
		channel: number,
		homeId: number,
		holdRx: boolean,
		alternateRx: boolean,
		routeOverride?: readonly number[] | null,
		destinationBeamModeOverride?: SoftwareControllerBeamMode | null,
		speedModified = false,
		applicationResponse = false,
		radioOptions?: SoftwareControllerRadioTransmitOptions,
	): Promise<ControllerTransmitResult> {
		const destinationBeamMode =
			destinationBeamModeOverride === undefined
				? this.#requiredBeamMode(request.destinationNodeId)
				: (destinationBeamModeOverride ?? undefined);
		const mpdu = this.#serializeMPDU(
			request,
			channel,
			homeId,
			routeOverride,
			destinationBeamMode,
			speedModified,
		);
		if (this.#networkManagementSession) {
			this.#diagnostic(
				`MAC TX channel ${channel}: ${[...mpdu]
					.map((byte) => byte.toString(16).padStart(2, "0"))
					.join("")}`,
			);
		}
		const channelConfig = this.#regionConfig!.channels.find(
			(candidate) => candidate.channel === channel,
		)!;
		const routedRepeaters =
			routeOverride === undefined
				? this.#routes.get(request.destinationNodeId)
				: (routeOverride ?? undefined);
		const directRoute =
			request.destinationNodeId !== NODE_ID_BROADCAST
			&& (request.transmitOptions & TRANSMIT_OPTION_ACK) !== 0
			&& routedRepeaters === undefined;
		const beamMode = directRoute ? destinationBeamMode : undefined;
		if (
			!canMatchAcknowledgementHomeId(
				radioOptions?.acknowledgementHomeId,
				this.#radio.capabilities,
				directRoute,
				!!beamMode,
			)
		) {
			this.#diagnostic(
				"Radio cannot match the requested foreign-network ACK identity",
			);
			return { status: ControllerTransmitStatus.Fail };
		}
		const holdApplicationResponse =
			applicationResponse
			&& !holdRx
			&& !alternateRx
			&& shouldHoldApplicationResponse(
				request.command,
				directRoute,
				!!beamMode,
			);
		if (
			beamMode
			&& (!this.#radio.capabilities.beamTx
				|| channelConfig.dataRate !== ProtocolDataRate.ZWave_40k
				|| holdRx
				|| alternateRx)
		) {
			return { status: ControllerTransmitStatus.Fail };
		}
		const limit = beamMode
			? this.#radio.limits.maximumBeamMPDUSize
			: this.#radio.limits.maximumMPDUSize;
		if (mpdu.length > limit)
			return { status: ControllerTransmitStatus.Fail };
		const result = await this.#transmitMPDU(
			mpdu,
			channel,
			holdRx || holdApplicationResponse,
			alternateRx,
			beamMode,
			radioOptions,
		);
		if (holdApplicationResponse) {
			if (
				result.status === ControllerTransmitStatus.OK
				&& this.#started
				&& !this.#faulted
				&& !this.#stopOperation
				&& !this.#factoryDefaultOperation
			) {
				this.#applicationResponseWindow.retain();
			} else {
				await this.#restoreNormalFiltering();
			}
		}
		if (
			result.status !== ControllerTransmitStatus.OK
			|| (!directRoute && !routedRepeaters?.length)
		)
			return { status: result.status };
		return {
			status: result.status,
			txReport: {
				// Radios do not expose calibrated RF airtime or ACK RSSI through this contract.
				txTicks: 0,
				txChannelNo: channel,
				ackChannelNo: channel,
				routeSchemeState: routedRepeaters?.length
					? RoutingScheme.LWR
					: RoutingScheme.Direct,
				repeaterNodeIds: [...(routedRepeaters ?? [])] as [
					number?,
					number?,
					number?,
					number?,
				],
				routeSpeed: channelConfig.dataRate,
				routingAttempts: result.attemptsUsed,
			},
		};
	}

	async #beginInclusion(
		request: ControllerNetworkManagementRequest,
		onEvent: (event: ControllerInclusionEvent) => void,
	): Promise<void> {
		if (request.networkWide || request.highPower) {
			throw new Error(
				"Software controller does not support network-wide or high-power inclusion",
			);
		}
		const radio = this.#requireManagementRadio();
		if (this.#factoryDefaultOperation) {
			throw new Error(
				"Cannot start inclusion while factory-default is active",
			);
		}
		if (this.#networkManagementSession) {
			throw new Error("Z-Wave network management is already active");
		}
		if (this.#sendInFlight) {
			throw new Error(
				"Cannot start inclusion while a transmission is active",
			);
		}

		const session: InclusionManagementSession = {
			kind: "inclusion",
			request,
			onEvent,
			ready: Promise.resolve(),
			failed: false,
			stopping: false,
		};
		this.#networkManagementSession = session;
		// Keep firmware-local ACK timing for our own network, but temporarily
		// accept the random/foreign Home ID used by an unassigned node's NIF.
		session.ready = (async () => {
			await this.#configure(radio, "inclusion");
			if (session.stopping) return;
			// A primary controller announces the controller-replication service on
			// the inclusion channel. End nodes may ignore this Protocol CC frame;
			// joining controllers use it to identify an inclusion transfer.
			await this.#sendTransferPresentation(session.kind);
		})();
		try {
			await session.ready;
			this.#scheduleTransferPresentation(session);
			const inclusionChannel = this.#getInclusionChannel();
			const channelInfo = this.#regionConfig!.channels.find(
				(candidate) => candidate.channel === inclusionChannel,
			)!;
			this.#diagnostic(
				`Inclusion receiver ready (Home ID filter disabled, fixed inclusion channel ${inclusionChannel}, ${protocolDataRateToString(channelInfo.dataRate)}, region ${this.#normalized.region})`,
			);
		} catch (error) {
			await this.#failNetworkManagementStartup(session, error);
		}
	}

	async #stopInclusion(): Promise<{ nodeId: number } | undefined> {
		const session = this.#networkManagementSession;
		if (!session || session.kind !== "inclusion") return undefined;
		session.stopping = true;
		this.#stopTransferPresentation(session);
		this.#rejectInclusionWaiter(
			session,
			new Error("Inclusion was stopped"),
		);
		await session.ready.catch(() => undefined);
		await session.operation?.catch(() => undefined);
		await this.#restoreNormalFiltering();
		if (this.#networkManagementSession === session) {
			this.#networkManagementSession = undefined;
		}
		return session.committedNodeId === undefined
			? undefined
			: { nodeId: session.committedNodeId };
	}

	async #beginExclusion(
		request: ControllerNetworkManagementRequest,
		onEvent: (event: ControllerExclusionEvent) => void,
	): Promise<void> {
		if (request.networkWide || request.highPower) {
			throw new Error(
				"Software controller does not support network-wide or high-power exclusion",
			);
		}
		const radio = this.#requireManagementRadio();
		if (this.#factoryDefaultOperation) {
			throw new Error(
				"Cannot start exclusion while factory-default is active",
			);
		}
		if (this.#networkManagementSession) {
			throw new Error("Z-Wave network management is already active");
		}
		if (this.#sendInFlight) {
			throw new Error(
				"Cannot start exclusion while a transmission is active",
			);
		}

		const session: ExclusionManagementSession = {
			kind: "exclusion",
			request,
			onEvent,
			ready: Promise.resolve(),
			failed: false,
			stopping: false,
		};
		this.#networkManagementSession = session;
		session.ready = (async () => {
			await this.#configure(radio, "inclusion");
			if (session.stopping) return;
			await this.#sendTransferPresentation(session.kind);
		})();
		try {
			await session.ready;
			this.#scheduleTransferPresentation(session);
			this.#diagnostic(
				`Exclusion receiver ready (Home ID filter disabled, fixed channel ${this.#getInclusionChannel()})`,
			);
		} catch (error) {
			await this.#failNetworkManagementStartup(session, error);
		}
	}

	async #failNetworkManagementStartup(
		session: NetworkManagementSession,
		error: unknown,
	): Promise<never> {
		this.#stopTransferPresentation(session);
		let failure = error;
		let cleanupFailure: { error: unknown } | undefined;
		try {
			await this.#restoreNormalFiltering();
		} catch (cleanupError) {
			cleanupFailure = { error: cleanupError };
			failure = new AggregateError(
				[...new Set([error, cleanupError])],
				`${session.kind} startup and receiver cleanup failed`,
			);
		} finally {
			if (this.#networkManagementSession === session) {
				this.#networkManagementSession = undefined;
			}
		}
		if (cleanupFailure) this.#handleRadioError(cleanupFailure.error);
		throw failure;
	}

	async #stopExclusion(): Promise<void> {
		const session = this.#networkManagementSession;
		if (!session || session.kind !== "exclusion") return;
		session.stopping = true;
		this.#stopTransferPresentation(session);
		await session.ready.catch(() => undefined);
		await session.operation?.catch(() => undefined);
		await this.#restoreNormalFiltering();
		if (this.#networkManagementSession === session) {
			this.#networkManagementSession = undefined;
		}
	}

	#requireManagementRadio(): SoftwareControllerRadio {
		if (!this.#regionConfig || !this.#started) {
			throw new Error("Software controller is not started");
		}
		if (this.#faulted) throw new Error("Software controller is faulted");
		return this.#radio;
	}

	async #restoreNormalFiltering(): Promise<void> {
		if (!this.#started) return;
		const mode =
			this.#faulted
			|| this.#factoryDefaultOperation
			|| this.#stopOperation
				? "disabled"
				: "network";
		try {
			await this.#configure(this.#radio, mode);
		} catch (error) {
			this.#faulted = true;
			if (this.#networkManagementSession) {
				this.#stopTransferPresentation(this.#networkManagementSession);
			}
			if (mode === "network") {
				try {
					await this.#configure(this.#radio, "disabled");
				} catch (disableError) {
					throw new AggregateError(
						[...new Set([error, disableError])],
						"Receiver restoration and MAC disable failed",
					);
				}
			}
			throw error;
		}
	}

	#nextNodeId(): number | undefined {
		for (let nodeId = 1; nodeId <= CLASSIC_NODE_ID_MAX; nodeId++) {
			if (
				!this.#includedNodeIds.has(nodeId)
				&& !this.#quarantinedNodeIds.has(nodeId)
			)
				return nodeId;
		}
		return undefined;
	}

	#preferredNodeChannel(supportedDataRates: readonly number[]): number {
		for (const [bitsPerSecond, dataRate] of [
			[100_000, ProtocolDataRate.ZWave_100k],
			[40_000, ProtocolDataRate.ZWave_40k],
			[9_600, ProtocolDataRate.ZWave_9k6],
		] as const) {
			if (!supportedDataRates.includes(bitsPerSecond)) continue;
			const channel = this.#regionConfig!.channels.find(
				(candidate) => candidate.dataRate === dataRate,
			);
			if (channel) return channel.channel;
		}
		return this.#normalized.channel;
	}

	#assignmentSpeedModified(
		channel: number,
		peerBitRates: readonly number[],
	): boolean {
		const channels = this.#regionConfig!.channels;
		return shouldSetSpeedModified(
			channels.find((candidate) => candidate.channel === channel)!
				.dataRate,
			channels.map((candidate) => candidate.dataRate),
			peerBitRates,
		);
	}

	#channelForDataRate(dataRate: ProtocolDataRate): number {
		return (
			this.#regionConfig!.channels.find(
				(candidate) => candidate.dataRate === dataRate,
			)?.channel ?? this.#normalized.channel
		);
	}

	#getInclusionChannel(): number {
		return (
			this.#normalized.inclusionChannel
			?? this.#channelForDataRate(ProtocolDataRate.ZWave_9k6)
		);
	}

	async #sendTransferPresentation(
		kind: NetworkManagementSession["kind"],
	): Promise<void> {
		// Keep the receiver on the selected channel between presentations instead of
		// returning to the 30 ms three-channel hopping loop, which can miss an
		// entire long 9.6 kbit/s NIF when it tunes in after sync.
		const inclusionChannel = this.#getInclusionChannel();
		const presentation = await this.#runSend(
			{
				destinationNodeId: NODE_ID_BROADCAST,
				command: Bytes.from([
					PROTOCOL_CC,
					0x08,
					kind === "inclusion" ? 0x05 : 0x03,
				]),
				transmitOptions: 0,
			},
			inclusionChannel,
			this.#normalized.homeId,
			true,
		);
		if (presentation.status !== ControllerTransmitStatus.OK) {
			throw new Error(
				`Controller ${kind} transfer presentation could not be transmitted`,
			);
		}
	}

	#scheduleTransferPresentation(session: NetworkManagementSession): void {
		if (session.presentationTimer) clearTimeout(session.presentationTimer);
		if (
			this.#networkManagementSession !== session
			|| this.#faulted
			|| session.stopping
			|| session.failed
			|| session.operation
		) {
			return;
		}
		session.presentationTimer = setTimeout(() => {
			delete session.presentationTimer;
			if (
				this.#networkManagementSession !== session
				|| this.#faulted
				|| session.stopping
				|| session.failed
				|| session.operation
			)
				return;
			if (this.#sendInFlight) {
				this.#scheduleTransferPresentation(session);
				return;
			}
			void this.#sendTransferPresentation(session.kind).then(
				() => this.#scheduleTransferPresentation(session),
				async (error) => {
					session.failed = true;
					await this.#restoreNormalFiltering().catch((cleanupError) =>
						this.#handleRadioError(cleanupError),
					);
					session.onEvent({ type: "failed", error });
					this.#reportError(error);
				},
			);
		}, 2_000);
		session.presentationTimer.unref();
	}

	#stopTransferPresentation(session: NetworkManagementSession): void {
		if (!session.presentationTimer) return;
		clearTimeout(session.presentationTimer);
		delete session.presentationTimer;
	}

	#assignIdsCommand(nodeId: number, homeId: number): Bytes {
		return Bytes.from([
			0x01,
			0x03,
			nodeId,
			(homeId >>> 24) & 0xff,
			(homeId >>> 16) & 0xff,
			(homeId >>> 8) & 0xff,
			homeId & 0xff,
		]);
	}

	#nodeMask(nodeIds: readonly number[]): Bytes {
		const highest = Math.max(0, ...nodeIds);
		const mask = Bytes.alloc(Math.max(1, Math.ceil(highest / 8)), 0);
		for (const nodeId of nodeIds) {
			if (nodeId < 1 || nodeId > CLASSIC_NODE_ID_MAX) continue;
			const index = nodeId - 1;
			mask[index >>> 3] = mask[index >>> 3] | (1 << (index & 0b111));
		}
		return mask;
	}

	#protocolInfoForNode(
		nodeId: number,
		joiningNodeId: number,
		joiningProtocolInfo: BytesView,
	): Bytes {
		if (nodeId === joiningNodeId) return Bytes.from(joiningProtocolInfo);
		const observed = this.getNodeProtocolInfo(nodeId);
		if (observed) return Bytes.from(observed);
		throw new Error(
			`Cannot replicate node ${nodeId} without observed protocol information`,
		);
	}

	#waitForInclusionCommand(
		session: InclusionManagementSession,
		sourceNodeId: number,
		description: string,
		predicate: (command: BytesView) => boolean,
		timeoutMs = CONTROLLER_REPLICATION_TIMEOUT_MS,
	): Promise<InclusionProtocolCommand> {
		if (session.commandWaiter) {
			throw new Error(
				"Another controller-replication response is already pending",
			);
		}
		return new Promise<InclusionProtocolCommand>((resolve, reject) => {
			let waiter!: InclusionCommandWaiter;
			const timer = setTimeout(() => {
				if (session.commandWaiter === waiter)
					delete session.commandWaiter;
				reject(new Error(`Timed out waiting for ${description}`));
			}, timeoutMs);
			timer.unref();
			waiter = {
				sourceNodeId,
				description,
				predicate,
				resolve,
				reject,
				timer,
			};
			session.commandWaiter = waiter;
		});
	}

	#resolveInclusionWaiter(
		session: InclusionManagementSession,
		received: InclusionProtocolCommand,
	): void {
		const waiter = session.commandWaiter;
		if (!waiter) return;
		clearTimeout(waiter.timer);
		delete session.commandWaiter;
		waiter.resolve(received);
	}

	#rejectInclusionWaiter(
		session: InclusionManagementSession,
		error: Error,
	): void {
		const waiter = session.commandWaiter;
		if (!waiter) return;
		clearTimeout(waiter.timer);
		delete session.commandWaiter;
		waiter.reject(error);
	}

	async #sendReplicationCommandAndWait(
		session: InclusionManagementSession,
		nodeId: number,
		channel: number,
		command: BytesView,
		description: string,
		predicate: (response: BytesView) => boolean,
		holdRx = true,
		alternateRx = false,
		responseTimeoutMs = CONTROLLER_REPLICATION_TIMEOUT_MS,
	): Promise<InclusionProtocolCommand> {
		const response = this.#waitForInclusionCommand(
			session,
			nodeId,
			description,
			predicate,
			responseTimeoutMs,
		);
		const result = await this.#runSend(
			{
				destinationNodeId: nodeId,
				command,
				transmitOptions: TRANSMIT_OPTION_ACK,
			},
			channel,
			this.#normalized.homeId,
			holdRx,
			alternateRx,
		);
		this.#diagnostic(
			`${description} transmit status ${result.status} on channel ${channel}`,
		);
		if (
			result.status !== ControllerTransmitStatus.OK
			&& result.status !== ControllerTransmitStatus.NoAck
		) {
			this.#rejectInclusionWaiter(
				session,
				new Error(
					`${description} transmission failed with status ${result.status}`,
				),
			);
		}
		return response;
	}

	async #sendReplicationCommandAcrossChannels(
		session: InclusionManagementSession,
		nodeId: number,
		channel: number,
		command: BytesView,
		description: string,
		predicate: (response: BytesView) => boolean,
	): Promise<InclusionProtocolCommand> {
		for (const alternateRx of [false, true]) {
			try {
				return await this.#sendReplicationCommandAndWait(
					session,
					nodeId,
					channel,
					command,
					description,
					predicate,
					true,
					alternateRx,
					CONTROLLER_REPLICATION_CHANNEL_TIMEOUT_MS,
				);
			} catch (error) {
				if (session.stopping) throw error;
				this.#diagnostic(
					`${description} was not received on ${alternateRx ? "the alternate" : "the transmit"} channel`,
				);
			}
		}
		return this.#sendReplicationCommandAndWait(
			session,
			nodeId,
			channel,
			command,
			description,
			predicate,
			false,
			false,
		);
	}

	#isProtocolCommand(command: BytesView, protocolCommand: number): boolean {
		return (
			command.length >= 2
			&& command[0] === PROTOCOL_CC
			&& command[1] === protocolCommand
		);
	}

	#waitForProtocolCommand(
		sourceNodeId: number,
		predicate: (command: BytesView) => boolean,
		timeoutMs: number,
	): Promise<Bytes> {
		if (this.#protocolCommandWaiter) {
			throw new Error(
				"Another Z-Wave Protocol command response is pending",
			);
		}
		return new Promise<Bytes>((resolve, reject) => {
			let waiter!: ProtocolCommandWaiter;
			const timer = setTimeout(() => {
				if (this.#protocolCommandWaiter === waiter) {
					this.#protocolCommandWaiter = undefined;
				}
				reject(
					new Error(
						"Timed out waiting for a Z-Wave Protocol response",
					),
				);
			}, timeoutMs);
			timer.unref();
			waiter = { sourceNodeId, predicate, resolve, reject, timer };
			this.#protocolCommandWaiter = waiter;
		});
	}

	#resolveProtocolCommandWaiter(
		sourceNodeId: number,
		command: BytesView,
	): boolean {
		const waiter = this.#protocolCommandWaiter;
		if (
			!waiter
			|| waiter.sourceNodeId !== sourceNodeId
			|| !waiter.predicate(command)
		)
			return false;
		clearTimeout(waiter.timer);
		this.#protocolCommandWaiter = undefined;
		waiter.resolve(Bytes.from(command));
		return true;
	}

	#rejectProtocolCommandWaiter(error: Error): void {
		const waiter = this.#protocolCommandWaiter;
		if (!waiter) return;
		clearTimeout(waiter.timer);
		this.#protocolCommandWaiter = undefined;
		waiter.reject(error);
	}

	#replicationDataRate(channel: number): number {
		const dataRate = this.#regionConfig!.channels.find(
			(candidate) => candidate.channel === channel,
		)?.dataRate;
		if (dataRate === ProtocolDataRate.ZWave_100k) return 3;
		if (dataRate === ProtocolDataRate.ZWave_40k) return 2;
		return 1;
	}

	#returnRouteDestinationSpeed(channel: number): number {
		const dataRate = this.#regionConfig!.channels.find(
			(candidate) => candidate.channel === channel,
		)?.dataRate;
		// Assign Return Route carries the Network Layer destination-speed
		// enumeration, not the PHY data-rate bit mask. Values 3..7 are reserved;
		// a Classic 100 kbit/s destination therefore advertises its interoperable
		// R2/40 kbit/s route speed here.
		if (
			dataRate === ProtocolDataRate.ZWave_100k
			|| dataRate === ProtocolDataRate.ZWave_40k
		)
			return 0x02;
		return 0x01;
	}

	async #sendReplicationTerminal(
		nodeId: number,
		channel: number,
		command: BytesView,
		description: string,
		holdRx = true,
	): Promise<void> {
		const result = await this.#runSend(
			{
				destinationNodeId: nodeId,
				command,
				transmitOptions: TRANSMIT_OPTION_ACK,
			},
			channel,
			this.#normalized.homeId,
			holdRx,
		);
		if (result.status !== ControllerTransmitStatus.OK) {
			throw new Error(`${description} was not acknowledged`);
		}
	}

	async #replicateControllerNetwork(
		session: InclusionManagementSession,
		nodeId: number,
		channel: number,
		dataRate: number,
		joiningProtocolInfo: BytesView,
	): Promise<void> {
		session.assignedNodeId = nodeId;
		const existingNodeIds = [...this.#includedNodeIds].toSorted(
			(left, right) => left - right,
		);
		const candidateMask = this.#nodeMask(existingNodeIds);
		if (session.stopping) throw new Error("Inclusion was stopped");
		await this.#sendReplicationTerminal(
			nodeId,
			channel,
			Bytes.concat([
				[PROTOCOL_CC, 0x04, candidateMask.length],
				candidateMask,
				[0x00, dataRate],
			]),
			"controller neighbor discovery",
		);
		await wait(this.#normalized.controllerNeighborDiscoveryDelayMs);

		if (session.stopping) throw new Error("Inclusion was stopped");
		const rangeInfo = await this.#sendReplicationCommandAcrossChannels(
			session,
			nodeId,
			channel,
			Bytes.from([PROTOCOL_CC, 0x05]),
			"controller range information",
			(command) =>
				this.#isProtocolCommand(command, PROTOCOL_RANGE_INFO)
				&& command.length >= 3
				&& command.length >= 3 + command[2],
		);

		const replicatedNodeIds = [...existingNodeIds, nodeId].toSorted(
			(left, right) => left - right,
		);
		let transferSequence = 1;
		let transferChannel = rangeInfo.channel;
		for (const replicatedNodeId of replicatedNodeIds) {
			if (session.stopping) throw new Error("Inclusion was stopped");
			const protocolInfo = this.#protocolInfoForNode(
				replicatedNodeId,
				nodeId,
				joiningProtocolInfo,
			);
			const completed = await this.#sendReplicationCommandAcrossChannels(
				session,
				nodeId,
				transferChannel,
				Bytes.concat([
					[PROTOCOL_CC, 0x09, transferSequence, replicatedNodeId],
					protocolInfo,
				]),
				`controller node information for node ${replicatedNodeId}`,
				(command) =>
					this.#isProtocolCommand(command, PROTOCOL_COMMAND_COMPLETE)
					&& command.length >= 3
					&& command[2] === transferSequence,
			);
			transferChannel = completed.channel;
			transferSequence = (transferSequence % 0xff) + 1;
		}

		// There are no reliable topology rows in the current controller state.
		// The reference 500-series stack emits zero Transfer Range Info records
		// for this empty topology, which is a valid 0..N replication loop.
		await this.#sendReplicationTerminal(
			nodeId,
			transferChannel,
			Bytes.from([PROTOCOL_CC, 0x11, this.#normalized.ownNodeId, 0x01]),
			"SUC node information",
		);
		await this.#sendReplicationTerminal(
			nodeId,
			transferChannel,
			Bytes.from([PROTOCOL_CC, 0x0b, 0x01]),
			"controller transfer completion",
			false,
		);
	}

	#controllerStateSnapshot(): SoftwareControllerState {
		const includedNodeIds = [...this.#includedNodeIds].toSorted(
			(left, right) => left - right,
		);
		const quarantinedNodeIds = [...this.#quarantinedNodeIds].toSorted(
			(left, right) => left - right,
		);
		const nodeChannels = new Map(this.#nodeChannels);
		const nodeNeighbors = new Map<number, readonly number[]>();
		for (const [nodeId, neighbors] of this.#nodeNeighbors) {
			nodeNeighbors.set(nodeId, Object.freeze([...neighbors]));
		}
		const repeaterNodeIds = new Set(this.#repeaterNodeIds);
		const nodeProtocolInfo = new Map<number, Uint8Array>();
		for (const [nodeId, protocolInfo] of this.#nodeProtocolInfo) {
			nodeProtocolInfo.set(nodeId, Bytes.from(protocolInfo));
		}
		const routes = new Map<number, readonly number[]>();
		for (const [nodeId, repeaters] of this.#routes) {
			routes.set(nodeId, Object.freeze([...repeaters]));
		}
		return {
			homeId: this.#normalized.homeId,
			ownNodeId: this.#normalized.ownNodeId,
			includedNodeIds,
			quarantinedNodeIds,
			nodeChannels,
			nodeNeighbors,
			nodeProtocolInfo,
			repeaterNodeIds,
			routes,
		};
	}

	#emptyControllerStateSnapshot(homeId: number): SoftwareControllerState {
		return {
			homeId,
			ownNodeId: 1,
			includedNodeIds: [1],
			quarantinedNodeIds: [],
			nodeChannels: new Map(),
			nodeNeighbors: new Map(),
			nodeProtocolInfo: new Map(),
			repeaterNodeIds: new Set(),
			routes: new Map(),
		};
	}

	async #persistControllerState(
		state = this.#controllerStateSnapshot(),
	): Promise<void> {
		const callback = this.#options.onControllerStateChanged;
		if (!callback) return;
		const operation = this.#persistenceTail.then(() => callback(state));
		// Continue draining newer snapshots, but retain any failed durable write
		// so shutdown cannot release ownership of uncertain network state.
		this.#persistenceTail = operation.catch((error: unknown) => {
			this.#persistenceError ??= { error };
		});
		await operation;
	}

	async #rememberNodeChannel(nodeId: number, channel: number): Promise<void> {
		if (
			nodeId === this.#normalized.ownNodeId
			|| !this.#includedNodeIds.has(nodeId)
			|| this.#nodeChannels.get(nodeId) === channel
		)
			return;
		this.#nodeChannels.set(nodeId, channel);
		this.#diagnostic(
			`Learned logical channel ${channel} for node ${nodeId}`,
		);
		try {
			await this.#persistControllerState();
		} catch (error) {
			this.#diagnostic(
				`Node ${nodeId} channel could not be persisted: ${this.#errorMessage(error)}`,
			);
		}
	}

	#matchesRequestedNodeType(
		request: ControllerNetworkManagementRequest,
		nodeType: NodeType,
	): boolean {
		return (
			request.nodeType === "any"
			|| (request.nodeType === "controller"
				&& nodeType === NodeType.Controller)
			|| (request.nodeType === "end-node"
				&& nodeType === NodeType["End Node"])
		);
	}

	#handleInclusionNIF(
		session: InclusionManagementSession,
		mpdu: MPDU,
		info: MPDURxInfo,
	): void {
		if (
			session.stopping
			|| session.failed
			|| session.committedNodeId !== undefined
			|| session.operation
		)
			return;

		let nodeInformation: NodeInformationFrame;
		try {
			nodeInformation = parseOverAirNodeInformationFrame(
				mpdu.payload.subarray(2),
			);
		} catch (error) {
			this.#diagnostic(
				`Ignored malformed inclusion NIF: ${this.#errorMessage(error)}`,
			);
			return;
		}
		if (
			!this.#matchesRequestedNodeType(
				session.request,
				nodeInformation.nodeType,
			)
		) {
			this.#diagnostic(
				`Ignored inclusion NIF because node type ${nodeInformation.nodeType} does not match the requested type`,
			);
			return;
		}
		const nodeId = this.#nextNodeId();
		if (nodeId === undefined) {
			this.#stopTransferPresentation(session);
			session.failed = true;
			session.onEvent({ type: "failed" });
			return;
		}

		this.#stopTransferPresentation(session);
		const operation = this.#completeInclusion(
			session,
			nodeId,
			nodeInformation,
			info.channel,
			mpdu.homeId,
			mpdu.sourceNodeId,
			protocolInfoFromNIF(mpdu.payload.subarray(2), nodeInformation),
		);
		const trackedOperation = operation.finally(() => {
			if (session.operation === trackedOperation)
				delete session.operation;
		});
		session.operation = trackedOperation;
	}

	async #completeInclusion(
		session: InclusionManagementSession,
		nodeId: number,
		nodeInformation: NodeInformationFrame,
		receiveChannel: number,
		joiningHomeId: number,
		joiningNodeId: number,
		joiningProtocolInfo: BytesView,
	): Promise<void> {
		const joiningController =
			nodeInformation.nodeType === NodeType.Controller;
		let assignmentMayHaveSucceeded = false;
		const joiningBeamMode = joiningController
			? undefined
			: beamModeFromProtocolInfo(joiningProtocolInfo);
		const flirsChannel =
			joiningBeamMode
			&& nodeInformation.supportedDataRates.includes(40_000)
				? this.#regionConfig!.channels.find(
						(candidate) =>
							candidate.dataRate === ProtocolDataRate.ZWave_40k,
					)?.channel
				: undefined;
		let nodeChannel = joiningBeamMode
			? flirsChannel
			: this.#preferredNodeChannel(nodeInformation.supportedDataRates);
		const verificationChannels = joiningController
			? []
			: getInclusionVerificationChannels(
					this.#regionConfig!.channels,
					nodeInformation.supportedDataRates,
					nodeChannel ?? this.#normalized.channel,
					receiveChannel,
					joiningBeamMode !== undefined,
				);
		try {
			await session.ready;
			if (session.stopping) return;
			if (joiningController) {
				// Validate the whole transfer before Assign IDs changes the joining
				// controller's radio identity irreversibly.
				for (const existingNodeId of this.#includedNodeIds) {
					this.#protocolInfoForNode(
						existingNodeId,
						nodeId,
						joiningProtocolInfo,
					);
				}
			}
			if (joiningBeamMode && flirsChannel === undefined) {
				throw new Error(
					"The joining FLiRS node has no usable Classic R2 40 kbit/s channel",
				);
			}
			if (joiningBeamMode && !this.#radio.capabilities.beamTx) {
				throw new Error(
					"The radio cannot provide the beam required by the joining FLiRS node",
				);
			}
			if (!joiningController && verificationChannels.length === 0) {
				throw new Error(
					"The joining node has no observed or advertised Classic verification channel",
				);
			}
			session.onEvent({ type: "node-found" });
			await wait(10);
			if (session.stopping) return;
			session.onEvent({
				type: "adding-node",
				nodeType:
					nodeInformation.nodeType === NodeType.Controller
						? "controller"
						: "end-node",
				node: {
					nodeId,
					basicDeviceClass: nodeInformation.basicDeviceClass,
					genericDeviceClass: nodeInformation.genericDeviceClass,
					specificDeviceClass: nodeInformation.specificDeviceClass,
					supportedCCs: nodeInformation.supportedCCs,
					...(nodeInformation.controlledCCs
						? { controlledCCs: nodeInformation.controlledCCs }
						: {}),
				},
			});
			if (session.stopping) return;

			// Until Assign IDs is processed, the joining node still filters on the
			// temporary/random Home ID it advertised in its NIF. Configure the
			// firmware ACK matcher and serialize the MPDU with that Home ID; the new
			// controller Home ID belongs in the command payload only.
			await this.#configure(
				this.#requireManagementRadio(),
				"inclusion",
				joiningHomeId,
			);
			const assignResult = await this.#runSend(
				{
					destinationNodeId: joiningNodeId,
					command: this.#assignIdsCommand(
						nodeId,
						this.#normalized.homeId,
					),
					transmitOptions: TRANSMIT_OPTION_ACK,
				},
				receiveChannel,
				joiningHomeId,
				false,
				false,
				undefined,
				undefined,
				this.#assignmentSpeedModified(
					receiveChannel,
					nodeInformation.supportedDataRates,
				),
			);
			this.#diagnostic(
				`Assign IDs transmit status ${assignResult.status} on channel ${receiveChannel}`,
			);
			if (
				assignResult.status !== ControllerTransmitStatus.OK
				&& assignResult.status !== ControllerTransmitStatus.NoAck
			) {
				throw new Error(
					`Assign IDs transmission failed with status ${assignResult.status}`,
				);
			}
			assignmentMayHaveSucceeded = true;

			// An Assign IDs ACK can be lost after the node has already changed IDs.
			// End nodes can be verified with a NOP. A controller instead expects the
			// complete Protocol CC topology transfer and will not answer that NOP.
			await this.#restoreNormalFiltering();
			// A 500-series controller can transmit its NIF and accept Assign IDs
			// before its learn-mode state machine reports Started. Give its new
			// Home ID/node identity time to settle before the first replication
			// command; otherwise Find Nodes may arrive while it still ignores the
			// assigned network.
			await wait(
				joiningController ? CONTROLLER_ASSIGNMENT_SETTLE_MS : 20,
			);
			if (joiningController) {
				const replicationChannel = nodeChannel!;
				await this.#replicateControllerNetwork(
					session,
					nodeId,
					replicationChannel,
					this.#replicationDataRate(replicationChannel),
					joiningProtocolInfo,
				);
			} else {
				let verifiedChannel: number | undefined;
				for (const channel of verificationChannels) {
					if (session.stopping)
						throw new Error("Inclusion was stopped");
					// NOP is idempotent. Keep all new-node data local until an ACK
					// verifies its identity, without borrowing routes from another ID.
					const verifyResult = await this.#runSend(
						{
							destinationNodeId: nodeId,
							command: Uint8Array.of(0x00),
							transmitOptions: TRANSMIT_OPTION_ACK,
						},
						channel,
						this.#normalized.homeId,
						false,
						false,
						joiningBeamMode ?? null,
						null,
						this.#assignmentSpeedModified(
							channel,
							nodeInformation.supportedDataRates,
						),
					);
					this.#diagnostic(
						`Assigned node ${nodeId} verification status ${verifyResult.status} on channel ${channel}`,
					);
					if (verifyResult.status === ControllerTransmitStatus.OK) {
						verifiedChannel = channel;
						break;
					}
					if (verifyResult.status !== ControllerTransmitStatus.NoAck)
						break;
				}
				if (verifiedChannel === undefined) {
					throw new Error(
						"The assigned node ID could not be verified on an observed or advertised Classic channel",
					);
				}
				nodeChannel = verifiedChannel;
			}

			this.#includedNodeIds.add(nodeId);
			this.#nodeChannels.set(nodeId, nodeChannel!);
			this.#nodeProtocolInfo.set(nodeId, Bytes.from(joiningProtocolInfo));
			this.#directNeighborNodeIds.add(nodeId);
			this.#rememberDirectedNeighbor(this.#normalized.ownNodeId, nodeId);
			this.#rememberDirectedNeighbor(nodeId, this.#normalized.ownNodeId);
			if (nodeInformation.isRouting) this.#repeaterNodeIds.add(nodeId);
			session.committedNodeId = nodeId;
			try {
				await this.#persistControllerState();
			} catch (error) {
				// RF assignment is irreversible here. Preserve the in-memory node and
				// complete inclusion honestly instead of reporting a reusable node ID.
				this.#diagnostic(
					`Node ${nodeId} was included, but persistent state failed: ${this.#errorMessage(error)}`,
				);
			}
			// The RF assignment was verified, even if Stop raced the operation.
			// Complete the callback sequence so the facade records it consistently.
			session.onEvent({ type: "protocol-done" });
			this.#diagnostic(`Inclusion committed as node ${nodeId}`);
		} catch (error) {
			this.#rejectInclusionWaiter(
				session,
				error instanceof Error ? error : new Error(String(error)),
			);
			if (assignmentMayHaveSucceeded) {
				this.#quarantinedNodeIds.add(nodeId);
				this.#diagnostic(
					`Node ID ${nodeId} quarantined after incomplete post-assignment inclusion`,
				);
				try {
					await this.#persistControllerState();
				} catch (persistError) {
					this.#diagnostic(
						`Quarantine for node ID ${nodeId} could not be persisted: ${this.#errorMessage(persistError)}`,
					);
				}
				if (joiningController) {
					await this.#runSend(
						{
							destinationNodeId: nodeId,
							command: Bytes.from([PROTOCOL_CC, 0x0b, 0x00]),
							transmitOptions: TRANSMIT_OPTION_ACK,
						},
						nodeChannel!,
					).catch(() => ({ status: ControllerTransmitStatus.Fail }));
				}
			}
			if (session.stopping) {
				await this.#restoreNormalFiltering().catch((error) =>
					this.#reportError(error),
				);
				return;
			}
			this.#diagnostic(`Inclusion failed: ${this.#errorMessage(error)}`);
			session.failed = true;
			session.onEvent({ type: "failed" });
			await this.#restoreNormalFiltering().catch((error) =>
				this.#reportError(error),
			);
		}
	}

	#handleExclusionNIF(
		session: ExclusionManagementSession,
		mpdu: MPDU,
		info: MPDURxInfo,
	): void {
		if (session.stopping || session.failed || session.operation) return;
		const target = getExclusionTarget(mpdu, this.#normalized);
		if (!target) return;
		if (
			!this.#matchesRequestedNodeType(
				session.request,
				target.nodeInformation.nodeType,
			)
		) {
			return;
		}

		this.#stopTransferPresentation(session);
		const operation = this.#completeExclusion(
			session,
			target.nodeId,
			target.callbackNodeId,
			target.nodeInformation.nodeType,
			info.channel,
			target.nodeInformation.supportedDataRates,
			target.acknowledgementHomeId,
		);
		const trackedOperation = operation.finally(() => {
			if (session.operation === trackedOperation)
				delete session.operation;
		});
		session.operation = trackedOperation;
	}

	async #completeExclusion(
		session: ExclusionManagementSession,
		nodeId: number,
		callbackNodeId: number,
		nodeType: NodeType,
		receiveChannel: number,
		peerBitRates: readonly number[],
		acknowledgementHomeId?: number,
	): Promise<void> {
		try {
			await session.ready;
			await this.#activeSend;
			if (session.stopping || session.failed) return;
			session.onEvent({ type: "node-found" });
			if (session.stopping) return;
			// A learning foreign node accepts Assign IDs on the excluding
			// controller's Home ID (Network Specification NWK:01C8.1). Numeric
			// node-ID collisions must not borrow our routes or FLiRS metadata.
			const result = await this.#runSend(
				{
					destinationNodeId: nodeId,
					command: this.#assignIdsCommand(0, 0),
					transmitOptions: TRANSMIT_OPTION_ACK,
				},
				receiveChannel,
				this.#normalized.homeId,
				false,
				false,
				null,
				null,
				this.#assignmentSpeedModified(receiveChannel, peerBitRates),
				acknowledgementHomeId === undefined
					? undefined
					: { acknowledgementHomeId },
			);
			if (result.status !== ControllerTransmitStatus.OK) {
				throw new Error(
					"The leaving node did not acknowledge Assign IDs",
				);
			}

			session.onEvent({
				type: "removing-node",
				nodeType:
					nodeType === NodeType.Controller
						? "controller"
						: "end-node",
				nodeId: callbackNodeId,
			});
			if (callbackNodeId !== 0) {
				this.#includedNodeIds.delete(nodeId);
				this.#quarantinedNodeIds.delete(nodeId);
				this.#nodeChannels.delete(nodeId);
				this.#nodeProtocolInfo.delete(nodeId);
				this.#flirsAwakeUntil.delete(nodeId);
				this.#directNeighborNodeIds.delete(nodeId);
				this.#nodeNeighbors.delete(nodeId);
				this.#repeaterNodeIds.delete(nodeId);
				this.#routes.delete(nodeId);
				for (const [sourceNodeId, neighbors] of this.#nodeNeighbors) {
					if (!neighbors.includes(nodeId)) continue;
					this.#nodeNeighbors.set(
						sourceNodeId,
						Object.freeze(
							neighbors.filter(
								(neighborId) => neighborId !== nodeId,
							),
						),
					);
				}
				for (const [destinationNodeId, route] of this.#routes) {
					if (route.includes(nodeId))
						this.#routes.delete(destinationNodeId);
				}
				try {
					await this.#persistControllerState();
				} catch (error) {
					// Assign IDs(0, 0) was ACKed and cannot be rolled back. Keep the
					// in-memory removal and complete honestly instead of resurrecting the
					// node ID in this session or reporting an RF failure.
					this.#diagnostic(
						`Node ${nodeId} was excluded, but persistent state failed: ${this.#errorMessage(error)}`,
					);
				}
			}
			await this.#restoreNormalFiltering().catch((error) => {
				this.#reportError(error);
				this.#diagnostic(
					`Node ${nodeId} was excluded, but normal filtering could not be restored: ${this.#errorMessage(error)}`,
				);
			});
			await wait(10);
			// Assign IDs(0, 0) is irreversible from the controller's perspective.
			// Report completion even when Stop raced the in-flight RF operation.
			session.onEvent({ type: "done" });
		} catch {
			session.failed = true;
			session.onEvent({ type: "failed" });
			await this.#restoreNormalFiltering().catch((error) =>
				this.#reportError(error),
			);
		}
	}

	async #configure(
		radio: SoftwareControllerRadio,
		mode: "disabled" | "network" | "inclusion",
		homeId = this.#normalized.homeId,
		ownNodeId = this.#normalized.ownNodeId,
	): Promise<void> {
		this.#applicationResponseWindow.cancel();
		await radio.configure({
			homeId,
			ownNodeId,
			filterHomeId: mode === "network",
			autoAck: mode !== "disabled",
		});
	}

	#expireApplicationResponseWindow(): void {
		if (
			!this.#started
			|| this.#faulted
			|| this.#stopOperation
			|| this.#sendInFlight
			|| this.#networkManagementSession
			|| this.#factoryDefaultOperation
		)
			return;
		// Take the same fence as a transmission before the first async radio call.
		// A new TX can supersede an idle lease, but cannot race its RX restore.
		this.#sendInFlight = true;
		const operation = this.#restoreNormalFiltering()
			.catch((error: unknown) => {
				this.#handleRadioError(error);
				throw error;
			})
			.finally(() => {
				if (this.#activeSend === operation) {
					this.#activeSend = undefined;
					this.#sendInFlight = false;
				}
			});
		this.#activeSend = operation;
		void operation.catch(() => undefined);
	}

	async #transmitMPDU(
		mpdu: BytesView,
		channel: number,
		holdRx = false,
		alternateRx = false,
		beamMode?: SoftwareControllerBeamMode,
		radioOptions?: SoftwareControllerRadioTransmitOptions,
	) {
		this.#applicationResponseWindow.cancel();
		try {
			return await this.#radio.transmit({
				...radioOptions,
				mpdu,
				channel,
				holdRx,
				alternateRx,
				beamMode,
				txPowerDeciDbm: this.#normalized.txPower,
				cca: this.#normalized.cca,
				maxAttempts: this.#normalized.maxAttempts,
			});
		} catch (error) {
			this.#handleRadioError(error);
			return { status: ControllerTransmitStatus.Fail };
		}
	}

	#serializeMPDU(
		request: ControllerTransmitRequest,
		channelNumber: number,
		homeId = this.#normalized.homeId,
		routeOverride?: readonly number[] | null,
		destinationBeamMode?: SoftwareControllerBeamMode,
		speedModified = false,
	): Bytes {
		const channel = this.#regionConfig!.channels.find(
			(candidate) => candidate.channel === channelNumber,
		)!;
		const headerFormat = getProtocolHeaderFormat(
			rfRegionToRadioProtocolMode(this.#normalized.region),
			channelNumber,
		);
		const sequenceNumber = this.#nextSequenceNumber(headerFormat);

		const repeaters =
			routeOverride === undefined
				? this.#routes.get(request.destinationNodeId)
				: (routeOverride ?? undefined);
		const common = {
			homeId,
			sourceNodeId: this.#normalized.ownNodeId,
			destinationNodeId: request.destinationNodeId,
			ackRequested:
				request.destinationNodeId !== NODE_ID_BROADCAST
				&& !!(request.transmitOptions & TRANSMIT_OPTION_ACK),
			sequenceNumber,
			// A learning NIF supplies peer capabilities before its network identity
			// is stable. A reduced direct rate must be marked independently of the
			// logical channel number (G.9959 §8.1.3.3.4).
			speedModified:
				speedModified
				&& headerFormat === ProtocolHeaderFormat.Classic2Channel
				&& !repeaters
				&& request.destinationNodeId !== NODE_ID_BROADCAST,
			payload: request.command,
		};
		const mpdu = repeaters
			? new RoutedZWaveMPDU({
					...common,
					headerType: MPDUHeaderType.Singlecast,
					routed: true,
					direction: "outbound",
					routedAck: false,
					routedError: false,
					// The source starts before the first repeater. Each forwarding hop
					// advances this zero-based index; starting at one skips repeater 0
					// on routes with more than one repeater.
					hop: 0,
					repeaters,
					...(destinationBeamMode
						? {
								destinationWakeupType:
									destinationBeamMode === BEAM_MODE_LONG
										? ("1000ms" as const)
										: ("250ms" as const),
							}
						: {}),
				})
			: new SinglecastZWaveMPDU(common);
		if (
			repeaters
			&& headerFormat !== ProtocolHeaderFormat.Classic2Channel
		) {
			throw new Error(
				"Explicit routed paths currently require Classic 1/2 channels",
			);
		}
		return mpdu.serialize({
			channel: channelNumber,
			region: this.#normalized.region,
			protocolDataRate: channel.dataRate,
		});
	}

	#nextSequenceNumber(headerFormat: ProtocolHeaderFormat): number {
		if (headerFormat === ProtocolHeaderFormat.Classic2Channel) {
			this.#sequenceNumber = ((this.#sequenceNumber ?? 0) % 0x0f) + 1;
			return this.#sequenceNumber;
		}
		if (headerFormat === ProtocolHeaderFormat.Classic3Channel) {
			this.#sequenceNumber = ((this.#sequenceNumber ?? 0xff) + 1) & 0xff;
			return this.#sequenceNumber;
		}
		throw new Error(
			"Software controller does not support Long Range MPDUs",
		);
	}

	async #performExplorerProbe(
		request: ControllerTransmitRequest,
		channelNumber: number,
	): Promise<ControllerTransmitResult> {
		const channel = this.#regionConfig!.channels.find(
			(candidate) => candidate.channel === channelNumber,
		);
		if (!channel || !isClassicDataRate(channel.dataRate)) {
			return { status: ControllerTransmitStatus.NoRoute };
		}
		const headerFormat = getProtocolHeaderFormat(
			rfRegionToRadioProtocolMode(this.#normalized.region),
			channelNumber,
		);
		if (headerFormat !== ProtocolHeaderFormat.Classic2Channel) {
			return { status: ControllerTransmitStatus.NoRoute };
		}

		const frameHandle = this.#nextSequenceNumber(headerFormat);
		const mpdu = new NormalExplorerZWaveMPDU({
			homeId: this.#normalized.homeId,
			sourceNodeId: this.#normalized.ownNodeId,
			destinationNodeId: request.destinationNodeId,
			ackRequested: true,
			headerType: MPDUHeaderType.Explorer,
			sequenceNumber: frameHandle,
			routed: false,
			speedModified: false,
			version: 1,
			command: ExplorerFrameCommand.Normal,
			stop: false,
			sourceRouted: false,
			direction: "outbound",
			randomTXInterval: 250,
			ttl: 4,
			repeaters: [],
			payload: request.command,
		}).serialize({
			channel: channelNumber,
			region: this.#normalized.region,
			protocolDataRate: channel.dataRate,
		});
		if (mpdu.length > this.#radio.limits.maximumMPDUSize) {
			return { status: ControllerTransmitStatus.Fail };
		}

		const resultPromise = this.#waitForExplorerResult(
			request.destinationNodeId,
			frameHandle,
		);
		const wireResult = await this.#transmitMPDU(mpdu, channelNumber);
		if (wireResult.status !== ControllerTransmitStatus.OK) {
			this.#rejectExplorerResultWaiter(
				new Error("Explorer MPDU was not transmitted"),
			);
			await resultPromise.catch(() => undefined);
			return wireResult;
		}

		let searchResult: SearchResultExplorerZWaveMPDU;
		try {
			searchResult = await resultPromise;
		} catch {
			return { status: ControllerTransmitStatus.NoRoute };
		}
		const route = [...searchResult.resultRepeaters];
		if (
			route.length > 4
			|| new Set(route).size !== route.length
			|| route.some(
				(nodeId) =>
					nodeId === this.#normalized.ownNodeId
					|| nodeId === request.destinationNodeId
					|| !this.#includedNodeIds.has(nodeId),
			)
		)
			return { status: ControllerTransmitStatus.NoRoute };

		if (route.length > 0) {
			for (const nodeId of route) this.#repeaterNodeIds.add(nodeId);
			this.#rememberWorkingRoute(request.destinationNodeId, route);
		} else {
			this.#directNeighborNodeIds.add(request.destinationNodeId);
			this.#rememberDirectedNeighbor(
				this.#normalized.ownNodeId,
				request.destinationNodeId,
			);
			this.#rememberDirectedNeighbor(
				request.destinationNodeId,
				this.#normalized.ownNodeId,
			);
			void this.#persistControllerState().catch((error) =>
				this.#reportError(error),
			);
		}
		return {
			status: ControllerTransmitStatus.OK,
			txReport: {
				txTicks: 0,
				txChannelNo: channelNumber,
				ackChannelNo: channelNumber,
				routeSchemeState: RoutingScheme.Explore,
				repeaterNodeIds: route as [number?, number?, number?, number?],
				routeSpeed: channel.dataRate,
				routingAttempts: 1,
			},
		};
	}

	#waitForExplorerResult(
		destinationNodeId: number,
		frameHandle: number,
	): Promise<SearchResultExplorerZWaveMPDU> {
		this.#rejectExplorerResultWaiter(
			new Error("Explorer result was superseded"),
		);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.#explorerResultWaiter?.timer === timer) {
					this.#explorerResultWaiter = undefined;
				}
				reject(
					new Error("Timed out waiting for Explorer Search Result"),
				);
			}, EXPLORER_RESULT_TIMEOUT_MS);
			this.#explorerResultWaiter = {
				destinationNodeId,
				frameHandle,
				resolve,
				reject,
				timer,
			};
		});
	}

	#rejectExplorerResultWaiter(error: Error): void {
		const waiter = this.#explorerResultWaiter;
		if (!waiter) return;
		this.#explorerResultWaiter = undefined;
		clearTimeout(waiter.timer);
		waiter.reject(error);
	}

	#resolveExplorerResult(mpdu: MPDU): boolean {
		const waiter = this.#explorerResultWaiter;
		if (
			!waiter
			|| !(mpdu instanceof SearchResultExplorerZWaveMPDU)
			|| mpdu.homeId !== this.#normalized.homeId
			|| mpdu.sourceNodeId !== waiter.destinationNodeId
			|| mpdu.destinationNodeId !== this.#normalized.ownNodeId
			|| mpdu.searchingNodeId !== this.#normalized.ownNodeId
			|| mpdu.frameHandle !== waiter.frameHandle
		)
			return false;
		this.#explorerResultWaiter = undefined;
		clearTimeout(waiter.timer);
		waiter.resolve(mpdu);
		return true;
	}

	#rememberAcknowledgedDirectLink(
		request: ControllerTransmitRequest,
		result: ControllerTransmitResult,
	): void {
		if (
			result.status !== ControllerTransmitStatus.OK
			|| (result.txReport?.repeaterNodeIds?.length ?? 0) !== 0
			|| (request.transmitOptions & TRANSMIT_OPTION_ACK) === 0
			|| request.destinationNodeId === this.#normalized.ownNodeId
			|| !this.#includedNodeIds.has(request.destinationNodeId)
		)
			return;
		this.#directNeighborNodeIds.add(request.destinationNodeId);
		const changed =
			this.#rememberDirectedNeighbor(
				this.#normalized.ownNodeId,
				request.destinationNodeId,
			)
			| this.#rememberDirectedNeighbor(
				request.destinationNodeId,
				this.#normalized.ownNodeId,
			);
		if (changed) {
			void this.#persistControllerState().catch((error) =>
				this.#reportError(error),
			);
		}
	}

	#rememberDirectedNeighbor(
		sourceNodeId: number,
		destinationNodeId: number,
	): number {
		const neighbors = new Set(this.#nodeNeighbors.get(sourceNodeId) ?? []);
		if (neighbors.has(destinationNodeId)) return 0;
		neighbors.add(destinationNodeId);
		this.#nodeNeighbors.set(
			sourceNodeId,
			Object.freeze(
				[...neighbors].toSorted((left, right) => left - right),
			),
		);
		return 1;
	}

	#handleInclusionProtocolCommand(
		session: InclusionManagementSession,
		mpdu: MPDU,
		info: MPDURxInfo,
	): boolean {
		const destination = destinationNodeId(mpdu);
		if (
			session.assignedNodeId === undefined
			|| mpdu.homeId !== this.#normalized.homeId
			|| mpdu.sourceNodeId !== session.assignedNodeId
			|| destination !== this.#normalized.ownNodeId
			|| mpdu.payload.length < 2
			|| mpdu.payload[0] !== PROTOCOL_CC
		)
			return false;

		const command = Bytes.from(mpdu.payload);
		if (
			this.#isProtocolCommand(command, PROTOCOL_COMMAND_COMPLETE)
			&& command.length >= 3
		) {
			const sequence = command[2];
			if (session.lastCommandCompleteSequence === sequence) {
				this.#diagnostic(
					`Ignored duplicate controller Command Complete sequence ${sequence}`,
				);
				return true;
			}
		}

		const waiter = session.commandWaiter;
		if (
			waiter
			&& waiter.sourceNodeId === mpdu.sourceNodeId
			&& waiter.predicate(command)
		) {
			if (
				this.#isProtocolCommand(command, PROTOCOL_COMMAND_COMPLETE)
				&& command.length >= 3
			) {
				session.lastCommandCompleteSequence = command[2]!;
			}
			this.#diagnostic(
				`Received ${waiter.description} on channel ${info.channel}`,
			);
			this.#resolveInclusionWaiter(session, {
				command,
				channel: info.channel,
			});
			return true;
		}

		this.#diagnostic(
			`Ignored unexpected controller-replication command 0x${command[1].toString(16).padStart(2, "0")}`,
		);
		return true;
	}

	readonly #handleMPDU = (mpdu: MPDU, info: MPDURxInfo): void => {
		if (!this.#onFrame || this.#factoryDefaultOperation) return;
		const belongsToNetwork = mpdu.homeId === this.#normalized.homeId;
		const mayLearnChannel =
			belongsToNetwork && this.#networkManagementSession === undefined;
		if (mayLearnChannel && this.#includedNodeIds.has(mpdu.sourceNodeId)) {
			this.#markFlirsAwake(mpdu.sourceNodeId);
		}
		if (mpdu.headerType === MPDUHeaderType.Acknowledgement) {
			if (mayLearnChannel) {
				void this.#rememberNodeChannel(mpdu.sourceNodeId, info.channel);
			}
			if (this.#networkManagementSession) {
				this.#diagnostic(
					`MAC ACK observed from node ${mpdu.sourceNodeId} on channel ${info.channel}`,
				);
			}
			return;
		}
		if (this.#resolveExplorerResult(mpdu)) {
			void this.#rememberNodeChannel(mpdu.sourceNodeId, info.channel);
			return;
		}
		if (mpdu.payload.length === 0) return;

		const destination = destinationNodeId(mpdu);
		if (
			mpdu.homeId === this.#normalized.homeId
			&& destination === this.#normalized.ownNodeId
			&& this.#resolveProtocolCommandWaiter(
				mpdu.sourceNodeId,
				mpdu.payload,
			)
		)
			return;
		if (mayLearnChannel && destination === this.#normalized.ownNodeId) {
			void this.#rememberNodeChannel(mpdu.sourceNodeId, info.channel);
		}
		const session = this.#networkManagementSession;
		const isNodeInformationFrame = isNodeInformationFrameForController(
			mpdu.payload,
			destination,
			this.#normalized.ownNodeId,
		);
		if (session && isNodeInformationFrame) {
			this.#diagnostic(
				`NIF received: Home ID 0x${mpdu.homeId.toString(16).padStart(8, "0")}, source ${mpdu.sourceNodeId}, destination ${destination}, channel ${info.channel}, data rate ${info.protocolDataRate}`,
			);
		}
		if (
			session?.kind === "inclusion"
			&& isNodeInformationFrame
			&& (mpdu.sourceNodeId === 0
				|| mpdu.sourceNodeId === NODE_ID_LEARN_MODE)
		) {
			this.#handleInclusionNIF(session, mpdu, info);
			return;
		}
		if (
			session?.kind === "inclusion"
			&& isNodeInformationFrame
			&& mpdu.sourceNodeId !== 0
			&& mpdu.sourceNodeId !== NODE_ID_LEARN_MODE
		) {
			this.#diagnostic(
				`Ignored inclusion NIF from assigned node ${mpdu.sourceNodeId}; exclude or factory-reset the device first`,
			);
			return;
		}
		if (
			session?.kind === "exclusion"
			&& isNodeInformationFrame
			&& mpdu.sourceNodeId !== 0
		) {
			this.#handleExclusionNIF(session, mpdu, info);
			return;
		}
		if (
			session?.kind === "inclusion"
			&& this.#handleInclusionProtocolCommand(session, mpdu, info)
		)
			return;
		if (mpdu.homeId !== this.#normalized.homeId) return;

		if (
			mpdu instanceof SinglecastZWaveMPDU
			&& destination === this.#normalized.ownNodeId
			&& this.#includedNodeIds.has(mpdu.sourceNodeId)
		) {
			this.#directNeighborNodeIds.add(mpdu.sourceNodeId);
			if (
				this.#rememberDirectedNeighbor(
					mpdu.sourceNodeId,
					this.#normalized.ownNodeId,
				)
			) {
				void this.#persistControllerState().catch((error) =>
					this.#reportError(error),
				);
			}
		}
		if (
			isNodeInformationFrame
			&& this.#includedNodeIds.has(mpdu.sourceNodeId)
		) {
			try {
				const nodeInformation = parseOverAirNodeInformationFrame(
					mpdu.payload.subarray(2),
				);
				this.#nodeProtocolInfo.set(
					mpdu.sourceNodeId,
					protocolInfoFromNIF(
						mpdu.payload.subarray(2),
						nodeInformation,
					),
				);
				this.#markFlirsAwake(mpdu.sourceNodeId);
				if (nodeInformation.isRouting) {
					this.#repeaterNodeIds.add(mpdu.sourceNodeId);
				} else {
					this.#repeaterNodeIds.delete(mpdu.sourceNodeId);
				}
				void this.#persistControllerState().catch((error) =>
					this.#reportError(error),
				);
			} catch {
				// ApplicationUpdate owns malformed-NIF reporting.
			}
		}

		let frameType: ControllerApplicationFrame["frameType"] = "singlecast";
		if (mpdu instanceof MulticastZWaveMPDU) {
			if (!mpdu.destinationNodeIds.includes(this.#normalized.ownNodeId))
				return;
			frameType = "multicast";
		} else if (destination === 0xff) {
			frameType = "broadcast";
		} else if (destination !== this.#normalized.ownNodeId) {
			return;
		}

		const frame: ControllerApplicationFrame = {
			sourceNodeId: mpdu.sourceNodeId,
			command: mpdu.payload,
			frameType,
			isExploreFrame: mpdu instanceof ExplorerZWaveMPDU,
		};
		if (this.#nodeInformationRequest?.accept(frame)) return;
		this.#onFrame(frame);
	};

	readonly #handleRadioError = (error: unknown): void => {
		this.#applicationResponseWindow.cancel();
		this.#nodeInformationRequest?.cancel();
		if (this.#networkManagementSession) {
			this.#stopTransferPresentation(this.#networkManagementSession);
		}
		this.#faulted = true;
		this.#reportError(error);
	};

	#reportError(error: unknown): void {
		try {
			this.#options.onError?.(error);
		} catch {
			// Error observers are deliberately isolated from transport state.
		}
	}

	#diagnostic(message: string): void {
		try {
			this.#options.onDiagnostic?.(`[software-controller] ${message}`);
		} catch (error) {
			// Observability hooks must never participate in controller-state
			// transactions or disrupt RF protocol state machines.
			this.#reportError(error);
		}
	}

	#errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
