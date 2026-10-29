/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import {
	type MPDU,
	type NodeInformationFrame,
	SinglecastZWaveMPDU,
} from "@zwave-js/core";

import type { ControllerIdentity } from "./ControllerBackend.js";
import {
	isNodeInformationFrameForController,
	parseOverAirNodeInformationFrame,
} from "./NodeInformation.js";

export interface ExclusionTarget {
	readonly nodeId: number;
	/** Zero identifies a device outside this controller's network to the Driver. */
	readonly callbackNodeId: number;
	/** A foreign learning device may acknowledge on its previous network. */
	readonly acknowledgementHomeId?: number;
	readonly nodeInformation: NodeInformationFrame;
}

/** Classic exclusion is direct and its learning NIF never requests an ACK. */
export function getExclusionTarget(
	mpdu: MPDU,
	controller: ControllerIdentity,
): ExclusionTarget | undefined {
	if (
		!(mpdu instanceof SinglecastZWaveMPDU)
		|| mpdu.ackRequested
		|| !Number.isInteger(mpdu.sourceNodeId)
		|| mpdu.sourceNodeId < 1
		|| mpdu.sourceNodeId > 232
		|| (mpdu.homeId === controller.homeId
			&& mpdu.sourceNodeId === controller.ownNodeId)
		|| !isNodeInformationFrameForController(
			mpdu.payload,
			mpdu.destinationNodeId,
			controller.ownNodeId,
		)
	) {
		return undefined;
	}

	try {
		return {
			nodeId: mpdu.sourceNodeId,
			callbackNodeId:
				mpdu.homeId === controller.homeId ? mpdu.sourceNodeId : 0,
			acknowledgementHomeId:
				mpdu.homeId === controller.homeId ? undefined : mpdu.homeId,
			nodeInformation: parseOverAirNodeInformationFrame(
				mpdu.payload.subarray(2),
			),
		};
	} catch {
		return undefined;
	}
}
