/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import { expect, test } from "vitest";

import {
	SerialApiControl,
	SerialApiFunction,
	SerialApiMessageType,
	SerialApiStreamDecoder,
	encodeSerialApiFrame,
} from "./SerialAPI.js";

test("encodes the standard Serial API checksum", () => {
	expect(
		encodeSerialApiFrame({
			type: SerialApiMessageType.Request,
			functionType: SerialApiFunction.GetControllerVersion,
			payload: new Uint8Array(),
		}),
	).toEqual(Uint8Array.of(0x01, 0x03, 0x00, 0x15, 0xe9));
});

test("decodes fragmented frames and adjacent control bytes", () => {
	const decoder = new SerialApiStreamDecoder();
	const frame = encodeSerialApiFrame({
		type: SerialApiMessageType.Request,
		functionType: SerialApiFunction.GetControllerId,
		payload: new Uint8Array(),
	});
	expect(decoder.push(frame.slice(0, 2))).toEqual([]);
	const decoded = decoder.push(
		Uint8Array.from([...frame.slice(2), SerialApiControl.ACK, ...frame]),
	);
	expect(decoded.map((chunk) => chunk.kind)).toEqual([
		"frame",
		"control",
		"frame",
	]);
	expect(decoded[1]).toEqual({
		kind: "control",
		control: SerialApiControl.ACK,
	});
});

test("rejects a bad checksum without discarding the next frame", () => {
	const decoder = new SerialApiStreamDecoder();
	const frame = encodeSerialApiFrame({
		type: SerialApiMessageType.Request,
		functionType: SerialApiFunction.GetControllerId,
		payload: new Uint8Array(),
	});
	const broken = frame.slice();
	broken[broken.length - 1] ^= 0xff;
	const decoded = decoder.push(Uint8Array.from([...broken, ...frame]));
	expect(decoded[0].kind).toBe("invalid");
	expect(decoded[1].kind).toBe("frame");
});
