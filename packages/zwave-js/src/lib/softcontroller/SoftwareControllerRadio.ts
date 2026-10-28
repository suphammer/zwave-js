/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import type {
	ChannelConfiguration,
	MPDU,
	ProtocolDataRate,
	RFRegion,
} from "@zwave-js/core";
import type { BytesView } from "@zwave-js/shared";

import type {
	ControllerIdentity,
	ControllerTransmitStatus,
} from "./ControllerBackend.js";

export interface SoftwareControllerRegionConfig {
	region: RFRegion;
	channelConfig: ChannelConfiguration;
	channels: readonly {
		channel: number;
		frequency: number;
		dataRate: ProtocolDataRate;
	}[];
}

export interface SoftwareControllerRadioCapabilities {
	/** These operations must complete on the radio, without a host USB round trip. */
	localAck: true;
	localTransmitAck: true;
	explorerTargetReply: true;
	routedAckStatus: true;
	explorerTx: boolean;
	beamTx: boolean;
}

export type SoftwareControllerBeamMode = "250ms" | "1000ms";

export interface SoftwareControllerRadioConfiguration extends ControllerIdentity {
	filterHomeId: boolean;
	autoAck: boolean;
}

export interface SoftwareControllerRadioTransmitRequest {
	mpdu: BytesView;
	channel: number;
	txPowerDeciDbm?: number;
	cca: boolean;
	maxAttempts: 1 | 2 | 3;
	holdRx: boolean;
	alternateRx: boolean;
	beamMode?: SoftwareControllerBeamMode;
}

export interface SoftwareControllerRadioTransmitResult {
	status: ControllerTransmitStatus;
	/** Actual attempts reported by the local MAC; absent if not queued. */
	attemptsUsed?: number;
	beamsUsed?: number;
}

export interface SoftwareControllerMPDURxInfo {
	channel: number;
	protocolDataRate: ProtocolDataRate;
}

/**
 * Radio boundary for the Classic software controller. Link ACK timing, ACK
 * matching, bounded retries and an atomic beam/MPDU operation belong to the
 * radio implementation. A backend must fail closed if those guarantees cannot
 * be negotiated; a host timer cannot implement them.
 */
export interface SoftwareControllerRadio {
	readonly capabilities: SoftwareControllerRadioCapabilities;
	readonly limits: {
		maximumMPDUSize: number;
		/** Zero when the radio cannot perform an atomic beam/MPDU operation. */
		maximumBeamMPDUSize: number;
	};
	start(
		onMPDU: (mpdu: MPDU, info: SoftwareControllerMPDURxInfo) => void,
		onError: (error: unknown) => void,
	): Promise<SoftwareControllerRegionConfig>;
	configure(
		configuration: SoftwareControllerRadioConfiguration,
	): Promise<void>;
	transmit(
		request: SoftwareControllerRadioTransmitRequest,
	): Promise<SoftwareControllerRadioTransmitResult>;
	/** Disables automatic ACK and closes the physical radio, propagating cleanup failures. */
	stop(): Promise<void>;
}
