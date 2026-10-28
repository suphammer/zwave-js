/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import {
	BasicDeviceClass,
	NodeType,
	parseNodeInformationFrame,
	parseNodeProtocolInfo,
	type NodeInformationFrame,
} from "@zwave-js/core";
import { Bytes, type BytesView } from "@zwave-js/shared";

/** Recognize both direct and broadcast NIFs addressed to this controller. */
export function isNodeInformationFrameForController(
	command: BytesView,
	destinationNodeId: number | undefined,
	ownNodeId: number,
): boolean {
	// Classic learn nodes may reply directly to Transfer Presentation rather
	// than broadcast their NIF (Network Specification §4.5.4.1).
	return (
		(destinationNodeId === 0xff || destinationNodeId === ownNodeId)
		&& command.length >= 2
		&& command[0] === 0x01
		&& command[1] === 0x01
	);
}

/**
 * Parse the NIF body carried by a raw Z-Wave Protocol CC Node Information
 * Frame. Controllers carry a Basic device class on air; end nodes omit it and
 * derive it from the protocol flags instead (Application CC Specification §3.4.1).
 */
export function parseOverAirNodeInformationFrame(
	buffer: BytesView,
): NodeInformationFrame {
	const protocolInfo = parseNodeProtocolInfo(buffer, 0);
	if (protocolInfo.nodeType === NodeType.Controller) {
		return parseNodeInformationFrame(buffer);
	}
	const basicDeviceClass = protocolInfo.isRouting
		? BasicDeviceClass["Routing End Node"]
		: BasicDeviceClass["End Node"];
	return parseNodeInformationFrame(
		Bytes.concat([
			buffer.subarray(0, 3),
			[basicDeviceClass],
			buffer.subarray(3),
		]),
	);
}
