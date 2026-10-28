/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

export const SerialApiControl = {
	SOF: 0x01,
	ACK: 0x06,
	NAK: 0x15,
	CAN: 0x18,
} as const;

export type SerialApiControlByte = (typeof SerialApiControl)[Exclude<
	keyof typeof SerialApiControl,
	"SOF"
>];

export enum SerialApiMessageType {
	Request = 0x00,
	Response = 0x01,
}

/**
 * Function IDs supported by the in-process software controller binding.
 *
 * The numeric values are part of the Silicon Labs Serial API wire protocol.
 * The binding advertises only functions whose complete backend contract exists.
 */
export enum SerialApiFunction {
	GetSerialApiInitData = 0x02,
	SetApplicationNodeInformation = 0x03,
	ApplicationCommand = 0x04,
	GetControllerCapabilities = 0x05,
	GetSerialApiCapabilities = 0x07,
	SoftReset = 0x08,
	SerialAPIStarted = 0x0a,
	SerialAPISetup = 0x0b,
	SendData = 0x13,
	GetControllerVersion = 0x15,
	SendDataAbort = 0x16,
	GetControllerId = 0x20,
	GetNodeProtocolInfo = 0x41,
	HardReset = 0x42,
	AssignReturnRoute = 0x46,
	DeleteReturnRoute = 0x47,
	RequestNodeNeighborUpdate = 0x48,
	ApplicationUpdate = 0x49,
	AddNodeToNetwork = 0x4a,
	RemoveNodeFromNetwork = 0x4b,
	GetSUCNodeId = 0x56,
	RequestNodeInfo = 0x60,
	GetRoutingInfo = 0x80,
}

/** Serial API Setup subcommands implemented by the software controller binding. */
export enum SerialApiSetupCommand {
	Unsupported = 0x00,
	GetSupportedCommands = 0x01,
	GetMaximumPayloadSize = 0x10,
}

export interface SerialApiFrame {
	type: SerialApiMessageType;
	functionType: number;
	payload: Uint8Array<ArrayBuffer>;
}

export type SerialApiDecodedChunk =
	| {
			kind: "control";
			control: SerialApiControlByte;
	  }
	| {
			kind: "frame";
			frame: SerialApiFrame;
			raw: Uint8Array<ArrayBuffer>;
	  }
	| {
			kind: "invalid";
			reason: "checksum" | "length" | "discarded";
			raw: Uint8Array<ArrayBuffer>;
	  };

function isControlByte(value: number): value is SerialApiControlByte {
	return (
		value === SerialApiControl.ACK
		|| value === SerialApiControl.NAK
		|| value === SerialApiControl.CAN
	);
}

/** Computes the XOR checksum used by the Z-Wave Serial API. */
export function computeSerialApiChecksum(
	frame: Uint8Array<ArrayBufferLike>,
): number {
	let checksum = 0xff;
	// SOF and the checksum byte itself are excluded.
	for (let index = 1; index < frame.length - 1; index++) {
		checksum ^= frame[index];
	}
	return checksum;
}

export function encodeSerialApiFrame(
	frame: SerialApiFrame,
): Uint8Array<ArrayBuffer> {
	if (
		frame.type !== SerialApiMessageType.Request
		&& frame.type !== SerialApiMessageType.Response
	) {
		throw new RangeError(
			`Invalid Serial API message type ${String(frame.type)}`,
		);
	}
	if (
		!Number.isInteger(frame.functionType)
		|| frame.functionType < 0
		|| frame.functionType > 0xff
	) {
		throw new RangeError(
			`Invalid Serial API function type ${frame.functionType}`,
		);
	}
	// LEN contains TYPE + FUNC + PAYLOAD + CHECKSUM and is one byte.
	if (frame.payload.length > 0xfc) {
		throw new RangeError("Serial API payload cannot exceed 252 bytes");
	}

	const encoded = new Uint8Array(frame.payload.length + 5);
	encoded[0] = SerialApiControl.SOF;
	encoded[1] = frame.payload.length + 3;
	encoded[2] = frame.type;
	encoded[3] = frame.functionType;
	encoded.set(frame.payload, 4);
	encoded[encoded.length - 1] = computeSerialApiChecksum(encoded);
	return encoded;
}

function concatBytes(
	left: Uint8Array<ArrayBufferLike>,
	right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
	if (left.length === 0) return Uint8Array.from(right);
	if (right.length === 0) return Uint8Array.from(left);
	const result = new Uint8Array(left.length + right.length);
	result.set(left);
	result.set(right, left.length);
	return result;
}

/**
 * Incremental decoder for the Driver-facing byte stream.
 *
 * Malformed frames are returned as `invalid` results so the binding can NAK
 * them without throwing out subsequent valid frames in the same USB chunk.
 */
export class SerialApiStreamDecoder {
	#buffer: Uint8Array<ArrayBuffer> = new Uint8Array();

	public reset(): void {
		this.#buffer = new Uint8Array();
	}

	public push(chunk: Uint8Array<ArrayBufferLike>): SerialApiDecodedChunk[] {
		this.#buffer = concatBytes(this.#buffer, chunk);
		const decoded: SerialApiDecodedChunk[] = [];

		while (this.#buffer.length > 0) {
			const first = this.#buffer[0];
			if (isControlByte(first)) {
				decoded.push({ kind: "control", control: first });
				this.#buffer = this.#buffer.slice(1);
				continue;
			}

			if (first !== SerialApiControl.SOF) {
				let nextMarker = 1;
				while (
					nextMarker < this.#buffer.length
					&& this.#buffer[nextMarker] !== SerialApiControl.SOF
					&& !isControlByte(this.#buffer[nextMarker])
				) {
					nextMarker++;
				}
				decoded.push({
					kind: "invalid",
					reason: "discarded",
					raw: this.#buffer.slice(0, nextMarker),
				});
				this.#buffer = this.#buffer.slice(nextMarker);
				continue;
			}

			if (this.#buffer.length < 2) break;
			const remainingLength = this.#buffer[1];
			if (remainingLength < 3) {
				decoded.push({
					kind: "invalid",
					reason: "length",
					raw: this.#buffer.slice(0, 2),
				});
				this.#buffer = this.#buffer.slice(2);
				continue;
			}

			const totalLength = remainingLength + 2;
			if (this.#buffer.length < totalLength) break;
			const raw = this.#buffer.slice(0, totalLength);
			this.#buffer = this.#buffer.slice(totalLength);

			if (raw.at(-1) !== computeSerialApiChecksum(raw)) {
				decoded.push({ kind: "invalid", reason: "checksum", raw });
				continue;
			}

			decoded.push({
				kind: "frame",
				raw,
				frame: {
					type: raw[2],
					functionType: raw[3],
					payload: raw.slice(4, -1),
				},
			});
		}

		return decoded;
	}
}
