/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RFRegion } from "@zwave-js/core";
import { db } from "@zwave-js/core/bindings/db/jsonl";
import { expect, test } from "vitest";

import { createSuphacapDriverBackend } from "./DriverBackend.js";
import type { SuphacapDriverBackendOptions } from "./DriverBackendTypes.js";

function options(cacheDir: string): SuphacapDriverBackendOptions {
	return {
		port: "/dev/suphacap-lifecycle-test-unused",
		cacheDir,
		controller: { type: "suphacap", homeId: 0xdcba_4321 },
		region: RFRegion.Europe,
		logConfig: { enabled: false },
		onError: () => {},
	};
}

async function verifyDatabaseClosed(directory: string): Promise<void> {
	const database = db.createInstance(join(directory, "controller.jsonl"));
	await database.open();
	await database.close();
}

test("rejects concurrent binding creation without starting a radio", async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "zwave-suphacap-concurrent-open-"),
	);
	const backend = await createSuphacapDriverBackend(options(directory));
	try {
		const opening = backend.binding();
		await expect(backend.binding()).rejects.toThrow("already opening");
		await opening;
	} finally {
		await backend.destroy();
		await rm(directory, { recursive: true, force: true });
	}
});

test("waits for an in-progress binding creation before closing the controller database", async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "zwave-suphacap-destroy-open-"),
	);
	try {
		const backend = await createSuphacapDriverBackend(options(directory));
		const opening = backend.binding();
		const closing = backend.destroy();
		await expect(opening).rejects.toThrow("was destroyed");
		await closing;
		await verifyDatabaseClosed(directory);
		await expect(backend.binding()).rejects.toThrow("was destroyed");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("shares close completion across cancellation and rejects a late start", async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "zwave-suphacap-close-binding-"),
	);
	const backend = await createSuphacapDriverBackend(options(directory));
	try {
		const binding = await backend.binding();
		const closing = binding.sink.close!();
		expect(binding.sink.abort!(new Error("cancelled"))).toBe(closing);
		expect(binding.source.cancel!("cancelled")).toBe(closing);
		await closing;
		expect(() => new WritableStream(binding.sink)).toThrow(
			"binding is closing",
		);
	} finally {
		await backend.destroy();
		await rm(directory, { recursive: true, force: true });
	}
});

test("cancels queued startup before it can outlive backend ownership", async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "zwave-suphacap-cancel-start-"),
	);
	try {
		const backend = await createSuphacapDriverBackend(options(directory));
		const binding = await backend.binding();
		const stream = new WritableStream(binding.sink);
		const starting = stream.getWriter().closed;
		const closing = backend.destroy();
		await expect(starting).rejects.toThrow("was destroyed");
		await closing;
		await verifyDatabaseClosed(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
