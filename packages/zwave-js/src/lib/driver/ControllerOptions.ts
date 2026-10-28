import { ZWaveError, ZWaveErrorCodes } from "@zwave-js/core";

/**
 * Configures the firmware-MAC Suphacap controller backend.
 * @public
 */
export interface SuphacapControllerOptions {
	type: "suphacap";
	/** First-run network identity seed. Saved controller state takes precedence. */
	homeId?: number;
	/** First-run controller node ID seed. Saved controller state takes precedence. */
	ownNodeId?: number;
	/** Logical RCP transmit channel, whose availability depends on the RF region. */
	transmitChannel?: number;
	/** Logical RCP channel for inclusion announcements. Defaults to the 9.6 kbit/s channel. */
	inclusionChannel?: number;
}

/**
 * Selects how the Driver communicates with its controller.
 * @public
 */
export type ControllerOptions =
	| { type: "serial-api" }
	| SuphacapControllerOptions;

function invalidControllerOptions(message: string): never {
	throw new ZWaveError(message, ZWaveErrorCodes.Driver_InvalidOptions);
}

function validateOptionalInteger(
	options: Record<string, unknown>,
	field: string,
	minimum: number,
	maximum: number,
): void {
	const value = options[field];
	if (
		value !== undefined
		&& (typeof value !== "number"
			|| !Number.isInteger(value)
			|| value < minimum
			|| value > maximum)
	) {
		invalidControllerOptions(
			`The controller.${field} option must be an integer between ${minimum} and ${maximum}`,
		);
	}
}

/** Validates a controller selection before opening its serial connection. */
export function validateControllerOptions(value: unknown): void {
	if (value === undefined) return;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		invalidControllerOptions("The controller option must be an object");
	}

	const options = value as Record<string, unknown>;
	if (options.type !== "serial-api" && options.type !== "suphacap") {
		invalidControllerOptions(
			"The controller.type option must be 'serial-api' or 'suphacap'",
		);
	}

	const fields =
		options.type === "suphacap"
			? [
					"type",
					"homeId",
					"ownNodeId",
					"transmitChannel",
					"inclusionChannel",
				]
			: ["type"];
	for (const field of Object.keys(options)) {
		if (!fields.includes(field)) {
			invalidControllerOptions(
				`The controller.${field} option is not supported by the ${options.type} backend`,
			);
		}
	}

	if (options.type === "suphacap") {
		validateOptionalInteger(options, "homeId", 1, 0xffff_fffe);
		validateOptionalInteger(options, "ownNodeId", 1, 232);
		validateOptionalInteger(options, "transmitChannel", 0, 255);
		validateOptionalInteger(options, "inclusionChannel", 0, 255);
	}
}
