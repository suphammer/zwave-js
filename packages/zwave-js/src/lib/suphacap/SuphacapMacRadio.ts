/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import {
	ChannelConfiguration,
	ProtocolDataRate,
	type MPDU,
	type LogConfig,
	type RFRegion,
} from "@zwave-js/core";
import {
	type RCPFunctionType,
	RCPMessage,
	RCPMessageType,
	type ZWaveSerialBindingFactory,
	type ZWaveSerialPortImplementation,
} from "@zwave-js/serial";
import { Bytes, type BytesView } from "@zwave-js/shared";

import type { ControllerFirmwareInfo } from "../driver/ControllerFirmwareInfo.js";
import type { RCPHost, PartialRCPHostOptions } from "../rcp/RCPHost.js";
import { ControllerTransmitStatus } from "../softcontroller/ControllerBackend.js";
import type {
	SoftwareControllerRadio,
	SoftwareControllerRadioCapabilities,
	SoftwareControllerRegionConfig,
	SoftwareControllerMPDURxInfo,
	SoftwareControllerBeamMode,
	SoftwareControllerRadioConfiguration,
	SoftwareControllerRadioTransmitRequest,
	SoftwareControllerRadioTransmitResult,
} from "../softcontroller/SoftwareControllerRadio.js";

import { getSuphacapControllerFirmwareInfo } from "./Firmware.js";
import { SuphacapRCPHost } from "./RCPHost.js";

const RCP_FUNC_MAC_ASSIST = 0x80 as RCPFunctionType;
const RCP_FUNC_MAC_TRANSMIT = 0x81 as RCPFunctionType;
const RCP_FUNC_MAC_BEAM_TRANSMIT = 0x82 as RCPFunctionType;

const MAC_ASSIST_VERSION = 0x01;
const MAC_ASSIST_GET_INFO = 0x00;
const MAC_ASSIST_CONFIGURE = 0x01;
const MAC_FLAG_FILTER_HOME = 0x01;
const MAC_FLAG_AUTO_ACK = 0x02;
const MAC_FLAGS_REQUIRED = MAC_FLAG_FILTER_HOME | MAC_FLAG_AUTO_ACK;
const MAC_CAP_AUTO_ACK = 0x01;
const MAC_CAP_TX_ACK = 0x02;
const MAC_CAP_EXPLORER_TX = 0x04;
const MAC_CAP_DIRECT_CONTINUOUS_BEAM_TX = 0x08;
const MAC_CAP_EXPLORER_TARGET_REPLY = 0x10;
const MAC_CAP_ROUTED_SILENT_ACK_STATUS = 0x20;
const MAC_CAPS_REQUIRED =
	MAC_CAP_AUTO_ACK
	| MAC_CAP_TX_ACK
	| MAC_CAP_EXPLORER_TARGET_REPLY
	| MAC_CAP_ROUTED_SILENT_ACK_STATUS;

const MAC_TRANSMIT_FLAG_CCA = 0x01;
const MAC_TRANSMIT_FLAG_HOLD_RX = 0x02;
const MAC_TRANSMIT_FLAG_ALTERNATE_RX = 0x04;
const MAC_TRANSMIT_POWER_UNCHANGED = 0x7fff;
const MAC_TRANSMIT_MAX_MPDU_LENGTH = 61;
const MAC_BEAM_TRANSMIT_MAX_MPDU_LENGTH = 59;
const MAC_BEAM_MODE_R2_SHORT = 0x01;
const MAC_BEAM_MODE_R2_LONG = 0x02;
// Firmware emits complete 24-byte beam frames: 278.4 ms / 1104.0 ms on air.
// Round the short duration upward when deriving the host callback timeout.
const MAC_BEAM_SHORT_DURATION_MS = 279;
const MAC_BEAM_LONG_DURATION_MS = 1_104;
// Firmware can spend the full missing-ACK deadline on every attempt and the
// maximum randomized backoff between attempts before emitting its callback.
// Keep an additional serial/event-loop margin after that deterministic budget.
const MAC_ACK_WAIT_MAX_MS = 260;
const MAC_RETRY_BACKOFF_MAX_MS = 39;
const MAC_COMPLETION_MARGIN_MS = 1_000;
export enum FirmwareMacStatus {
	OK = 0x00,
	NoAck = 0x01,
	Fail = 0x02,
	NotIdle = 0x03,
	NoRoute = 0x04,
	NotSupported = 0x05,
}

function homeIdBytes(homeId: number): Bytes {
	return Bytes.from([
		(homeId >>> 24) & 0xff,
		(homeId >>> 16) & 0xff,
		(homeId >>> 8) & 0xff,
		homeId & 0xff,
	]);
}

function macTransmitCompletionTimeoutMs(maxAttempts: number): number {
	return (
		maxAttempts * MAC_ACK_WAIT_MAX_MS
		+ (maxAttempts - 1) * MAC_RETRY_BACKOFF_MAX_MS
		+ MAC_COMPLETION_MARGIN_MS
	);
}

function macBeamTransmitCompletionTimeoutMs(
	maxAttempts: number,
	beamDurationMs: number,
): number {
	return (
		maxAttempts * (beamDurationMs + MAC_ACK_WAIT_MAX_MS)
		+ (maxAttempts - 1) * MAC_RETRY_BACKOFF_MAX_MS
		+ MAC_COMPLETION_MARGIN_MS
	);
}

function mapStatus(status: number): ControllerTransmitStatus {
	switch (status) {
		case FirmwareMacStatus.OK:
			return ControllerTransmitStatus.OK;
		case FirmwareMacStatus.NoAck:
			return ControllerTransmitStatus.NoAck;
		case FirmwareMacStatus.NotIdle:
			return ControllerTransmitStatus.NotIdle;
		case FirmwareMacStatus.NoRoute:
			return ControllerTransmitStatus.NoRoute;
		case FirmwareMacStatus.Fail:
		case FirmwareMacStatus.NotSupported:
		default:
			return ControllerTransmitStatus.Fail;
	}
}

function privateRequest(
	functionType: RCPFunctionType,
	payload: BytesView,
): RCPMessage {
	return new RCPMessage({
		type: RCPMessageType.Request,
		functionType,
		expectedResponse: functionType,
		payload: Bytes.from(payload),
	});
}

function requireResponse(
	message: RCPMessage,
	functionType: RCPFunctionType,
	minimumLength: number,
	label: string,
): Bytes {
	if (
		message.type !== RCPMessageType.Response
		|| message.functionType !== functionType
		|| message.payload.length < minimumLength
	) {
		throw new Error(
			`Malformed ${label} response from Suphacap RCP firmware`,
		);
	}
	return message.payload;
}

export interface SuphacapMacRadioOptions {
	port: string | ZWaveSerialPortImplementation | ZWaveSerialBindingFactory;
	region: RFRegion;
	channelConfiguration?: ChannelConfiguration;
	host?: PartialRCPHostOptions["host"];
	logConfig?: Partial<LogConfig>;
	callbackTimeoutMs?: number;
	onDiagnostic?: (message: string) => void;
}

/** Suphacap's private RCP MAC wire contract, without controller/network policy. */
export class SuphacapMacRadio implements SoftwareControllerRadio {
	public readonly limits = {
		maximumMPDUSize: MAC_TRANSMIT_MAX_MPDU_LENGTH,
		maximumBeamMPDUSize: MAC_BEAM_TRANSMIT_MAX_MPDU_LENGTH,
	};
	readonly #options: SuphacapMacRadioOptions;
	readonly #closingHosts = new WeakMap<RCPHost, Promise<void>>();
	readonly #startupCleanupErrors: unknown[] = [];
	#host: RCPHost | undefined;
	#regionConfig: SoftwareControllerRegionConfig | undefined;
	#firmwareInfo: ControllerFirmwareInfo | undefined;
	#onMPDU: Parameters<SoftwareControllerRadio["start"]>[0] | undefined;
	#onError: ((error: unknown) => void) | undefined;
	#firmwareMacCapabilities = 0;
	#beamTransactionId = 0;
	#faulted = false;
	#stopOperation: Promise<void> | undefined;

	public constructor(options: SuphacapMacRadioOptions) {
		this.#options = options;
		if (
			options.callbackTimeoutMs !== undefined
			&& (!Number.isFinite(options.callbackTimeoutMs)
				|| options.callbackTimeoutMs < 100)
		) {
			throw new RangeError("callbackTimeoutMs must be at least 100 ms");
		}
	}

	public get capabilities(): SoftwareControllerRadioCapabilities {
		return {
			// start() rejects firmware unless all four guarantees were negotiated.
			localAck: true,
			localTransmitAck: true,
			explorerTargetReply: true,
			routedAckStatus: true,
			explorerTx:
				(this.#firmwareMacCapabilities & MAC_CAP_EXPLORER_TX) !== 0,
			beamTx:
				(this.#firmwareMacCapabilities
					& MAC_CAP_DIRECT_CONTINUOUS_BEAM_TX)
				!== 0,
		};
	}

	public get firmwareInfo(): ControllerFirmwareInfo | undefined {
		return this.#firmwareInfo ? { ...this.#firmwareInfo } : undefined;
	}

	public async start(
		onMPDU: (mpdu: MPDU, info: SoftwareControllerMPDURxInfo) => void,
		onError: (error: unknown) => void,
	): Promise<SoftwareControllerRegionConfig> {
		await this.#stopOperation;
		if (this.#host) throw new Error("Suphacap radio is already started");
		if (this.#startupCleanupErrors.length)
			throw new AggregateError(
				this.#startupCleanupErrors,
				"Suphacap radio startup cleanup failed",
			);
		this.#stopOperation = undefined;
		this.#onMPDU = onMPDU;
		this.#onError = onError;
		try {
			let host = await this.#openHost();
			this.#host = host;
			const initial = this.#requireRegionConfig(host);
			const region = this.#options.region;
			const channelConfig =
				this.#options.channelConfiguration
				?? ChannelConfiguration.Classic;
			const changed =
				initial.region !== region
				|| initial.channelConfig !== channelConfig;
			// Retuning also verifies CC1101 initialization after every volatile startup.
			await host.setRegion(region, channelConfig);
			if (changed) {
				// RCPHost retains its decode context, so reopen after changing the PHY region.
				await this.#closeHost(host);
				this.#host = undefined;
				host = await this.#openHost();
				this.#host = host;
			}
			const config = this.#requireRegionConfig(host);
			if (
				config.region !== region
				|| config.channelConfig !== channelConfig
			)
				throw new Error(
					"Suphacap RCP did not retain the requested RF region",
				);
			this.#regionConfig = config;
			const firmwareInfo = getSuphacapControllerFirmwareInfo(
				host.firmwareVersion,
			);
			await this.#queryCapabilities(host);
			this.#firmwareInfo = firmwareInfo;
			this.#diagnostic(
				`${firmwareInfo.manufacturer} ${firmwareInfo.product} ${firmwareInfo.firmwareLabel} firmware ${firmwareInfo.firmwareVersion}; Driver requires >=${firmwareInfo.minimumVersion}, recommended baseline ${firmwareInfo.recommendedVersion}`,
			);
			host.on("mpdu received", onMPDU);
			this.#faulted = false;
			return config;
		} catch (error) {
			this.#reportError(error);
			await this.stop().catch((cleanupError) =>
				this.#reportError(cleanupError),
			);
			throw error;
		}
	}

	public stop(): Promise<void> {
		return (this.#stopOperation ??= this.#stop());
	}
	async #stop(): Promise<void> {
		const errors = [...this.#startupCleanupErrors];
		const host = this.#host;
		try {
			if (host) {
				if (this.#onMPDU) host.off("mpdu received", this.#onMPDU);
				await this.configure({
					homeId: 0,
					ownNodeId: 0,
					filterHomeId: false,
					autoAck: false,
				}).catch((error: unknown) => errors.push(error));
				await this.#closeHost(host).catch((error: unknown) =>
					errors.push(error),
				);
			}
		} finally {
			this.#host = undefined;
			this.#regionConfig = undefined;
			this.#firmwareInfo = undefined;
			this.#onMPDU = undefined;
			this.#firmwareMacCapabilities = 0;
		}
		if (errors.length)
			throw new AggregateError(
				errors,
				"Suphacap radio could not be stopped safely",
			);
	}

	public async configure(
		configuration: SoftwareControllerRadioConfiguration,
	): Promise<void> {
		const host = this.#host;
		if (!host) throw new Error("Suphacap radio is not started");
		const flags =
			(configuration.filterHomeId ? MAC_FLAG_FILTER_HOME : 0)
			| (configuration.autoAck ? MAC_FLAG_AUTO_ACK : 0);
		const response = await host.queueSerialApiCommand(
			privateRequest(
				RCP_FUNC_MAC_ASSIST,
				Bytes.concat([
					[MAC_ASSIST_CONFIGURE, MAC_ASSIST_VERSION, flags],
					flags
						? homeIdBytes(configuration.homeId)
						: Bytes.alloc(4, 0),
					[flags ? configuration.ownNodeId : 0],
				]),
			),
		);
		const payload = requireResponse(
			response,
			RCP_FUNC_MAC_ASSIST,
			4,
			"MAC CONFIGURE",
		);
		if (
			payload[0] !== MAC_ASSIST_CONFIGURE
			|| payload[1] !== MAC_ASSIST_VERSION
			|| payload[2] !== FirmwareMacStatus.OK
			|| payload[3] !== flags
		)
			throw new Error("Suphacap RCP rejected local MAC configuration");
	}

	public async transmit(
		request: SoftwareControllerRadioTransmitRequest,
	): Promise<SoftwareControllerRadioTransmitResult> {
		if (!this.#host || !this.#regionConfig)
			throw new Error("Suphacap radio is not started");
		if (this.#faulted) return { status: ControllerTransmitStatus.Fail };
		const channel = this.#regionConfig.channels.find(
			(candidate) => candidate.channel === request.channel,
		);
		const maxAttempts = request.maxAttempts;
		const txPower = request.txPowerDeciDbm ?? MAC_TRANSMIT_POWER_UNCHANGED;
		if (
			!channel
			|| !Number.isInteger(maxAttempts)
			|| maxAttempts < 1
			|| maxAttempts > 3
			|| !Number.isInteger(txPower)
			|| txPower < -0x8000
			|| txPower > 0x7fff
			|| (request.txPowerDeciDbm !== undefined
				&& txPower === MAC_TRANSMIT_POWER_UNCHANGED)
		) {
			return { status: ControllerTransmitStatus.Fail };
		}
		if (request.beamMode) {
			if (
				!this.capabilities.beamTx
				|| channel.dataRate !== ProtocolDataRate.ZWave_40k
				|| request.holdRx
				|| request.alternateRx
				|| request.mpdu.length > this.limits.maximumBeamMPDUSize
			)
				return { status: ControllerTransmitStatus.Fail };
			const transactionId = this.#nextBeamTransactionId();
			const mode =
				request.beamMode === "1000ms"
					? MAC_BEAM_MODE_R2_LONG
					: MAC_BEAM_MODE_R2_SHORT;
			const payload = Bytes.concat([
				[
					MAC_ASSIST_VERSION,
					transactionId,
					request.channel,
					(txPower >>> 8) & 0xff,
					txPower & 0xff,
					request.cca ? MAC_TRANSMIT_FLAG_CCA : 0,
					maxAttempts,
					mode,
				],
				request.mpdu,
			]);
			return this.#transmitBeam(
				payload,
				transactionId,
				request.beamMode,
				maxAttempts,
			);
		}
		if (request.mpdu.length > this.limits.maximumMPDUSize)
			return { status: ControllerTransmitStatus.Fail };
		const flags =
			(request.cca ? MAC_TRANSMIT_FLAG_CCA : 0)
			| (request.holdRx ? MAC_TRANSMIT_FLAG_HOLD_RX : 0)
			| (request.alternateRx ? MAC_TRANSMIT_FLAG_ALTERNATE_RX : 0);
		const payload = Bytes.concat([
			[
				MAC_ASSIST_VERSION,
				request.channel,
				(txPower >>> 8) & 0xff,
				txPower & 0xff,
				flags,
				maxAttempts,
			],
			request.mpdu,
		]);
		return this.#transmit(payload, maxAttempts);
	}

	async #openHost(): Promise<RCPHost> {
		const host = new SuphacapRCPHost(this.#options.port, {
			host: this.#options.host,
			logConfig: this.#options.logConfig,
		});
		host.on("error", this.#handleHostError);
		try {
			await host.start();
			return host;
		} catch (error) {
			await this.#closeHost(host).catch((cleanupError: unknown) => {
				this.#startupCleanupErrors.push(cleanupError);
				this.#reportError(cleanupError);
			});
			throw error;
		}
	}
	#closeHost(host: RCPHost): Promise<void> {
		const existing = this.#closingHosts.get(host);
		if (existing) return existing;
		if (this.#onMPDU) host.off("mpdu received", this.#onMPDU);
		host.off("error", this.#handleHostError);
		// Retain the original rejection: RCPHost's own repeated destroy can otherwise
		// remain pending after a physical serial-close error.
		const operation = host.destroy();
		this.#closingHosts.set(host, operation);
		return operation;
	}
	#requireRegionConfig(host: RCPHost): SoftwareControllerRegionConfig {
		const config = host.regionConfig;
		if (!config)
			throw new Error("Suphacap RCP did not report an RF region");
		return config;
	}
	#nextBeamTransactionId(): number {
		this.#beamTransactionId = (this.#beamTransactionId % 0xff) + 1;
		return this.#beamTransactionId;
	}
	async #queryCapabilities(host: RCPHost): Promise<void> {
		const response = await host.queueSerialApiCommand(
			privateRequest(RCP_FUNC_MAC_ASSIST, Bytes.of(MAC_ASSIST_GET_INFO)),
		);
		const payload = requireResponse(
			response,
			RCP_FUNC_MAC_ASSIST,
			4,
			"MAC GET_INFO",
		);
		if (
			payload[0] !== MAC_ASSIST_GET_INFO
			|| payload[1] !== MAC_ASSIST_VERSION
			|| (payload[2] & MAC_FLAGS_REQUIRED) !== MAC_FLAGS_REQUIRED
			|| (payload[3] & MAC_CAPS_REQUIRED) !== MAC_CAPS_REQUIRED
		) {
			throw new Error(
				"Suphacap RCP firmware lacks required local MAC capabilities",
			);
		}
		this.#firmwareMacCapabilities = payload[3]!;
		if ((this.#firmwareMacCapabilities & MAC_CAP_EXPLORER_TX) === 0) {
			this.#diagnostic(
				"Firmware supports direct/routed MAC only; Explorer route discovery is unavailable",
			);
		}
	}
	async #transmitBeam(
		payload: Bytes,
		transactionId: number,
		beamMode: SoftwareControllerBeamMode,
		maxAttempts: 1 | 2 | 3,
	): Promise<SoftwareControllerRadioTransmitResult> {
		const host = this.#host!;
		const callbackAbort = new AbortController();
		const beamDurationMs =
			beamMode === "1000ms"
				? MAC_BEAM_LONG_DURATION_MS
				: MAC_BEAM_SHORT_DURATION_MS;
		const callbackTimeoutMs = Math.max(
			this.#options.callbackTimeoutMs ?? 3000,
			macBeamTransmitCompletionTimeoutMs(maxAttempts, beamDurationMs),
		);
		const callbackPromise = host.waitForMessage<RCPMessage>(
			(message) =>
				message.type === RCPMessageType.Callback
				&& message.functionType === RCP_FUNC_MAC_BEAM_TRANSMIT
				&& message.payload.length === 5
				&& message.payload[0] === MAC_ASSIST_VERSION
				&& message.payload[1] === transactionId,
			callbackTimeoutMs,
			undefined,
			callbackAbort.signal,
		);
		// The callback can time out while the command response is still pending.
		// Observe it now, then handle the rejection through the await below.
		void callbackPromise.catch(() => undefined);

		try {
			const response = await host.queueSerialApiCommand(
				privateRequest(RCP_FUNC_MAC_BEAM_TRANSMIT, payload),
			);
			const responsePayload = requireResponse(
				response,
				RCP_FUNC_MAC_BEAM_TRANSMIT,
				3,
				"MAC_BEAM_TRANSMIT",
			);
			if (
				responsePayload[0] !== MAC_ASSIST_VERSION
				|| responsePayload[1] !== transactionId
			) {
				throw new Error("Mismatched MAC_BEAM_TRANSMIT response");
			}
			const queuedStatus = responsePayload[2];
			if (queuedStatus !== FirmwareMacStatus.OK) {
				callbackAbort.abort();
				return { status: mapStatus(queuedStatus) };
			}

			const callback = await callbackPromise;
			const attemptsUsed = callback.payload[3];
			const beamsUsed = callback.payload[4];
			const wireStatus = callback.payload[2];
			if (
				wireStatus !== FirmwareMacStatus.OK
				&& wireStatus !== FirmwareMacStatus.NoAck
				&& wireStatus !== FirmwareMacStatus.Fail
				&& wireStatus !== FirmwareMacStatus.NotIdle
				&& wireStatus !== FirmwareMacStatus.NoRoute
				&& wireStatus !== FirmwareMacStatus.NotSupported
			) {
				throw new Error("Malformed MAC_BEAM_TRANSMIT callback status");
			}
			const status = mapStatus(wireStatus);
			if (
				attemptsUsed > maxAttempts
				|| beamsUsed > attemptsUsed
				|| ((status === ControllerTransmitStatus.OK
					|| status === ControllerTransmitStatus.NoAck)
					&& (attemptsUsed < 1 || beamsUsed < 1))
				|| (status === ControllerTransmitStatus.NotIdle
					&& attemptsUsed < 1)
			) {
				throw new Error("Malformed MAC_BEAM_TRANSMIT attempt counts");
			}
			this.#diagnostic(
				`FLiRS beam TX ${transactionId} completed with status ${status}, ${attemptsUsed} attempts and ${beamsUsed} beams`,
			);
			if (status !== ControllerTransmitStatus.OK) return { status };
			return { status, attemptsUsed, beamsUsed };
		} catch (error) {
			callbackAbort.abort();
			// A transaction ID prevents late-callback misassociation, but a missing
			// terminal callback leaves the firmware operation state unknown.
			this.#faulted = true;
			this.#reportError(error);
			return { status: ControllerTransmitStatus.Fail };
		}
	}
	async #transmit(
		payload: Bytes,
		maxAttempts: 1 | 2 | 3,
	): Promise<SoftwareControllerRadioTransmitResult> {
		const host = this.#host!;
		const callbackAbort = new AbortController();
		const callbackTimeoutMs = Math.max(
			this.#options.callbackTimeoutMs ?? 3000,
			macTransmitCompletionTimeoutMs(maxAttempts),
		);
		const callbackPromise = host.waitForMessage<RCPMessage>(
			(message) =>
				message.type === RCPMessageType.Callback
				&& message.functionType === RCP_FUNC_MAC_TRANSMIT
				&& message.payload.length === 3
				&& message.payload[0] === MAC_ASSIST_VERSION,
			callbackTimeoutMs,
			undefined,
			callbackAbort.signal,
		);
		void callbackPromise.catch(() => undefined);

		try {
			const response = await host.queueSerialApiCommand(
				privateRequest(RCP_FUNC_MAC_TRANSMIT, payload),
			);
			const responsePayload = requireResponse(
				response,
				RCP_FUNC_MAC_TRANSMIT,
				2,
				"MAC_TRANSMIT",
			);
			if (responsePayload[0] !== MAC_ASSIST_VERSION) {
				throw new Error("Unsupported MAC_TRANSMIT response version");
			}
			const queuedStatus = responsePayload[1];
			if (queuedStatus !== FirmwareMacStatus.OK) {
				callbackAbort.abort();
				return { status: mapStatus(queuedStatus) };
			}

			const callback = await callbackPromise;
			const attemptsUsed = callback.payload[2];
			if (attemptsUsed < 1 || attemptsUsed > maxAttempts) {
				throw new Error("Malformed MAC_TRANSMIT attempts count");
			}
			const status = mapStatus(callback.payload[1]);
			return { status, attemptsUsed };
		} catch (error) {
			callbackAbort.abort();
			// With no transaction ID on 0x81, continuing after a timeout could
			// associate a late callback with a later send. Require a restart.
			this.#faulted = true;
			this.#reportError(error);
			return { status: ControllerTransmitStatus.Fail };
		}
	}

	readonly #handleHostError = (error: Error): void => {
		this.#faulted = true;
		this.#reportError(error);
	};
	#reportError(error: unknown): void {
		try {
			this.#onError?.(error);
		} catch {
			/* Error observers cannot change radio transaction state. */
		}
	}
	#diagnostic(message: string): void {
		try {
			this.#options.onDiagnostic?.(`[suphacap-mac] ${message}`);
		} catch (error) {
			this.#reportError(error);
		}
	}
}
