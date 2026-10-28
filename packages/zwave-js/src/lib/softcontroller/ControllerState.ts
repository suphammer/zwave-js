/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import { randomInt } from "node:crypto";

const STATE_VERSION = 5;
const CLASSIC_NODE_ID_MAX = 232;
const RADIO_CHANNEL_MAX = 0xff;

/** Random Home ID range mandated by the 500-series controller API. */
export const RANDOM_HOME_ID_MIN = 0xc000_0000;
export const RANDOM_HOME_ID_MAX = 0xffff_fffe;

interface StoredControllerState {
	version: typeof STATE_VERSION;
	homeId: number;
	ownNodeId: number;
	includedNodeIds: number[];
	nodeChannels: Record<string, number>;
	nodeNeighbors: Record<string, number[]>;
	repeaterNodeIds: number[];
	routes: Record<string, number[]>;
	/** Six-byte GetNodeProtocolInfo payload captured from the node's NIF. */
	nodeProtocolInfo: Record<string, number[]>;
	/** Assigned IDs whose inclusion may have changed RF state but did not commit. */
	quarantinedNodeIds: number[];
}

export interface ControllerState {
	readonly includedNodeIds: readonly number[];
	readonly quarantinedNodeIds: readonly number[];
	readonly nodeChannels: ReadonlyMap<number, number>;
	readonly nodeNeighbors: ReadonlyMap<number, readonly number[]>;
	readonly repeaterNodeIds: ReadonlySet<number>;
	readonly routes: ReadonlyMap<number, readonly number[]>;
	readonly nodeProtocolInfo: ReadonlyMap<number, Uint8Array>;
}

/** Complete controller identity and state from one complete database revision. */
export interface PersistedControllerState extends ControllerState {
	readonly homeId: number;
	readonly ownNodeId: number;
}

/** Generates a controller Home ID with Node's cryptographic random source. */
export function generateRandomHomeId(): number {
	// randomInt's upper bound is exclusive. The maximum legal random Home ID is
	// 0xfffffffe; 0xffffffff is reserved as the API boundary value.
	return randomInt(RANDOM_HOME_ID_MIN, RANDOM_HOME_ID_MAX + 1);
}

export function isRandomHomeId(value: unknown): value is number {
	return (
		Number.isInteger(value)
		&& Number(value) >= RANDOM_HOME_ID_MIN
		&& Number(value) <= RANDOM_HOME_ID_MAX
	);
}

function isNodeId(value: unknown): value is number {
	return (
		Number.isInteger(value)
		&& Number(value) >= 1
		&& Number(value) <= CLASSIC_NODE_ID_MAX
	);
}

function isChannel(value: unknown): value is number {
	return (
		Number.isInteger(value)
		&& Number(value) >= 0
		&& Number(value) <= RADIO_CHANNEL_MAX
	);
}

/** Parses one complete controller-state revision before accepting any network identity. */
export function parseControllerState(
	encoded: string,
	path: string = "controller state",
): PersistedControllerState {
	let value: unknown;
	try {
		value = JSON.parse(encoded);
	} catch (error) {
		throw new Error(`Invalid software controller state in ${path}`, {
			cause: error,
		});
	}
	if (typeof value !== "object" || value === null) {
		throw new Error(`Invalid software controller state in ${path}`);
	}
	const state = value as StoredControllerState;
	if (
		state.version !== STATE_VERSION
		|| !Number.isInteger(state.homeId)
		|| !isNodeId(state.ownNodeId)
		|| !Array.isArray(state.includedNodeIds)
		|| !state.includedNodeIds.every(isNodeId)
	) {
		throw new Error(`Invalid software controller state in ${path}`);
	}
	const { homeId, ownNodeId } = state;
	if (homeId <= 0 || homeId >= 0xffff_ffff) {
		throw new Error(`Invalid software controller state in ${path}`);
	}
	const includedNodeIds = [
		...new Set([ownNodeId, ...state.includedNodeIds]),
	].toSorted((left, right) => left - right);
	const nodeChannels = new Map<number, number>();
	const storedChannels = state.nodeChannels;
	if (
		typeof storedChannels !== "object"
		|| storedChannels === null
		|| Array.isArray(storedChannels)
	) {
		throw new Error(`Invalid software controller state in ${path}`);
	}
	for (const [nodeIdText, channel] of Object.entries(storedChannels)) {
		const nodeId = /^\d+$/.test(nodeIdText)
			? Number(nodeIdText)
			: Number.NaN;
		if (
			!isNodeId(nodeId)
			|| String(nodeId) !== nodeIdText
			|| nodeId === ownNodeId
			|| !includedNodeIds.includes(nodeId)
			|| !isChannel(channel)
			|| nodeChannels.has(nodeId)
		) {
			throw new Error(`Invalid software controller state in ${path}`);
		}
		nodeChannels.set(nodeId, channel);
	}
	const nodeNeighbors = new Map<number, readonly number[]>();
	const repeaterNodeIds = new Set<number>();
	const routes = new Map<number, readonly number[]>();
	if (
		typeof state.nodeNeighbors !== "object"
		|| state.nodeNeighbors === null
		|| Array.isArray(state.nodeNeighbors)
		|| !Array.isArray(state.repeaterNodeIds)
		|| typeof state.routes !== "object"
		|| state.routes === null
		|| Array.isArray(state.routes)
	) {
		throw new Error(`Invalid software controller state in ${path}`);
	}
	for (const [nodeIdText, neighbors] of Object.entries(state.nodeNeighbors)) {
		const nodeId = /^\d+$/.test(nodeIdText)
			? Number(nodeIdText)
			: Number.NaN;
		if (
			!isNodeId(nodeId)
			|| String(nodeId) !== nodeIdText
			|| !includedNodeIds.includes(nodeId)
			|| !Array.isArray(neighbors)
			|| neighbors.some(
				(neighbor) =>
					!isNodeId(neighbor)
					|| neighbor === nodeId
					|| !includedNodeIds.includes(neighbor),
			)
			|| new Set(neighbors).size !== neighbors.length
		) {
			throw new Error(`Invalid software controller state in ${path}`);
		}
		nodeNeighbors.set(
			nodeId,
			Object.freeze([...neighbors].toSorted((a, b) => a - b)),
		);
	}
	for (const nodeId of state.repeaterNodeIds) {
		if (
			!isNodeId(nodeId)
			|| nodeId === ownNodeId
			|| !includedNodeIds.includes(nodeId)
			|| repeaterNodeIds.has(nodeId)
		) {
			throw new Error(`Invalid software controller state in ${path}`);
		}
		repeaterNodeIds.add(nodeId);
	}
	for (const [nodeIdText, repeaters] of Object.entries(state.routes)) {
		const nodeId = /^\d+$/.test(nodeIdText)
			? Number(nodeIdText)
			: Number.NaN;
		if (
			!isNodeId(nodeId)
			|| String(nodeId) !== nodeIdText
			|| nodeId === ownNodeId
			|| !includedNodeIds.includes(nodeId)
			|| !Array.isArray(repeaters)
			|| repeaters.length < 1
			|| repeaters.length > 4
			|| repeaters.some(
				(repeater) =>
					!isNodeId(repeater)
					|| repeater === ownNodeId
					|| repeater === nodeId
					|| !includedNodeIds.includes(repeater),
			)
			|| new Set(repeaters).size !== repeaters.length
		) {
			throw new Error(`Invalid software controller state in ${path}`);
		}
		routes.set(nodeId, Object.freeze([...repeaters]));
	}
	const nodeProtocolInfo = new Map<number, Uint8Array>();
	if (
		typeof state.nodeProtocolInfo !== "object"
		|| state.nodeProtocolInfo === null
		|| Array.isArray(state.nodeProtocolInfo)
	) {
		throw new Error(`Invalid software controller state in ${path}`);
	}
	for (const [nodeIdText, protocolInfo] of Object.entries(
		state.nodeProtocolInfo,
	)) {
		const nodeId = /^\d+$/.test(nodeIdText)
			? Number(nodeIdText)
			: Number.NaN;
		if (
			!isNodeId(nodeId)
			|| String(nodeId) !== nodeIdText
			|| nodeId === ownNodeId
			|| !includedNodeIds.includes(nodeId)
			|| !Array.isArray(protocolInfo)
			|| protocolInfo.length !== 6
			|| protocolInfo.some(
				(byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff,
			)
			|| nodeProtocolInfo.has(nodeId)
		) {
			throw new Error(`Invalid software controller state in ${path}`);
		}
		nodeProtocolInfo.set(nodeId, Uint8Array.from(protocolInfo));
	}
	const quarantinedNodeIds: number[] = [];
	if (
		!Array.isArray(state.quarantinedNodeIds)
		|| state.quarantinedNodeIds.some(
			(nodeId) =>
				!isNodeId(nodeId)
				|| nodeId === ownNodeId
				|| includedNodeIds.includes(nodeId),
		)
		|| new Set(state.quarantinedNodeIds).size
			!== state.quarantinedNodeIds.length
	) {
		throw new Error(`Invalid software controller state in ${path}`);
	}
	quarantinedNodeIds.push(...state.quarantinedNodeIds);
	quarantinedNodeIds.sort((left, right) => left - right);
	return {
		homeId,
		ownNodeId,
		includedNodeIds,
		quarantinedNodeIds,
		nodeChannels,
		nodeNeighbors,
		repeaterNodeIds,
		routes,
		nodeProtocolInfo,
	};
}

/** Normalizes and validates all network state before it can be persisted. */
export function serializeControllerState(
	homeId: number,
	ownNodeId: number,
	controllerState: ControllerState,
): string {
	if (!Number.isInteger(homeId) || homeId <= 0 || homeId >= 0xffff_ffff) {
		throw new RangeError("homeId must be a valid 32-bit network Home ID");
	}
	if (
		!isNodeId(ownNodeId)
		|| !controllerState.includedNodeIds.every(isNodeId)
	) {
		throw new RangeError(
			"Controller state contains an invalid classic node ID",
		);
	}
	const normalized = [
		...new Set([ownNodeId, ...controllerState.includedNodeIds]),
	].toSorted((left, right) => left - right);
	const normalizedQuarantined = [
		...controllerState.quarantinedNodeIds,
	].toSorted((left, right) => left - right);
	if (
		new Set(normalizedQuarantined).size !== normalizedQuarantined.length
		|| normalizedQuarantined.some(
			(nodeId) =>
				!isNodeId(nodeId)
				|| nodeId === ownNodeId
				|| normalized.includes(nodeId),
		)
	) {
		throw new RangeError(
			"Controller state contains an invalid quarantined node ID",
		);
	}
	const normalizedChannels: Array<[number, number]> = [];
	for (const [nodeId, channel] of controllerState.nodeChannels) {
		if (
			!isNodeId(nodeId)
			|| nodeId === ownNodeId
			|| !normalized.includes(nodeId)
			|| !isChannel(channel)
		) {
			throw new RangeError(
				"Controller state contains an invalid node channel",
			);
		}
		normalizedChannels.push([nodeId, channel]);
	}
	normalizedChannels.sort(([left], [right]) => left - right);
	const normalizedNeighbors: Array<[number, number[]]> = [];
	for (const [nodeId, neighbors] of controllerState.nodeNeighbors) {
		const values = [...new Set(neighbors)].toSorted(
			(left, right) => left - right,
		);
		if (
			!isNodeId(nodeId)
			|| !normalized.includes(nodeId)
			|| values.length !== neighbors.length
			|| values.some(
				(neighbor) =>
					!isNodeId(neighbor)
					|| neighbor === nodeId
					|| !normalized.includes(neighbor),
			)
		) {
			throw new RangeError(
				"Controller state contains invalid node neighbors",
			);
		}
		normalizedNeighbors.push([nodeId, values]);
	}
	normalizedNeighbors.sort(([left], [right]) => left - right);
	const normalizedRepeaters = [...controllerState.repeaterNodeIds].toSorted(
		(left, right) => left - right,
	);
	if (
		new Set(normalizedRepeaters).size !== normalizedRepeaters.length
		|| normalizedRepeaters.some(
			(nodeId) =>
				!isNodeId(nodeId)
				|| nodeId === ownNodeId
				|| !normalized.includes(nodeId),
		)
	) {
		throw new RangeError(
			"Controller state contains an invalid repeater node",
		);
	}
	const normalizedRoutes: Array<[number, number[]]> = [];
	for (const [nodeId, repeaters] of controllerState.routes) {
		const values = [...repeaters];
		if (
			!isNodeId(nodeId)
			|| nodeId === ownNodeId
			|| !normalized.includes(nodeId)
			|| values.length < 1
			|| values.length > 4
			|| new Set(values).size !== values.length
			|| values.some(
				(repeater) =>
					!isNodeId(repeater)
					|| repeater === ownNodeId
					|| repeater === nodeId
					|| !normalized.includes(repeater),
			)
		) {
			throw new RangeError("Controller state contains an invalid route");
		}
		normalizedRoutes.push([nodeId, values]);
	}
	normalizedRoutes.sort(([left], [right]) => left - right);
	const normalizedProtocolInfo: Array<[number, number[]]> = [];
	for (const [nodeId, protocolInfo] of controllerState.nodeProtocolInfo) {
		if (
			!isNodeId(nodeId)
			|| nodeId === ownNodeId
			|| !normalized.includes(nodeId)
			|| protocolInfo.length !== 6
			|| [...protocolInfo].some(
				(byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff,
			)
		) {
			throw new RangeError(
				"Controller state contains invalid node protocol info",
			);
		}
		normalizedProtocolInfo.push([nodeId, [...protocolInfo]]);
	}
	normalizedProtocolInfo.sort(([left], [right]) => left - right);
	const state: StoredControllerState = {
		version: STATE_VERSION,
		homeId,
		ownNodeId,
		includedNodeIds: normalized,
		quarantinedNodeIds: normalizedQuarantined,
		nodeChannels: Object.fromEntries(normalizedChannels),
		nodeNeighbors: Object.fromEntries(normalizedNeighbors),
		repeaterNodeIds: normalizedRepeaters,
		routes: Object.fromEntries(normalizedRoutes),
		nodeProtocolInfo: Object.fromEntries(normalizedProtocolInfo),
	};
	return `${JSON.stringify(state, undefined, 2)}\n`;
}
