/*
 * SPDX-FileCopyrightText: 2026 Jon Suphammer
 * SPDX-License-Identifier: MIT
 */

import {
	access,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonlDB } from "@alcalzone/jsonl-db";
import { RFRegion } from "@zwave-js/core";
import { db } from "@zwave-js/core/bindings/db/jsonl";
import type {
	DatabaseFactory,
	DatabaseOptions,
} from "@zwave-js/shared/bindings";
import { expect, test, vi } from "vitest";

import {
	createSoftwareControllerDriverBackend,
	type SoftwareControllerDriverBackendOptions,
} from "./DriverBackend.js";

function options(cacheDir: string): SoftwareControllerDriverBackendOptions {
	return {
		cacheDir,
		homeId: 0xdcba_4321,
		region: RFRegion.Europe,
		radioFactory: () => {
			throw new Error("Storage validation must not construct a radio");
		},
		onError: () => {},
	};
}

test("holds the shared database lock until backend destruction", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zwave-controller-store-"));
	try {
		const backend = await createSoftwareControllerDriverBackend(
			options(directory),
		);
		await expect(
			createSoftwareControllerDriverBackend(options(directory)),
		).rejects.toThrow("Failed to lock DB file");
		const closing = backend.destroy();
		expect(backend.destroy()).toBe(closing);
		await closing;
		const reopened = await createSoftwareControllerDriverBackend({
			...options(directory),
			homeId: 0xcdab_1234,
		});
		await reopened.destroy();
		const database = db.createInstance<Record<string, unknown>>(
			join(directory, "controller.jsonl"),
		);
		await database.open();
		expect(database.size).toBe(1);
		expect(database.get("state")?.homeId).toBe(0xdcba_4321);
		expect(database.get("state")?.includedNodeIds).toEqual([1]);
		await database.close();
		expect(await readdir(directory)).toEqual(["controller.jsonl"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("uses the configured shared lock directory", async () => {
	const directory = await mkdtemp(join(tmpdir(), "zwave-controller-locks-"));
	try {
		const databaseOptions = {
			lockfile: { directory: join(directory, "locks") },
			throttleFS: { intervalMs: 60_000 },
		};
		const backend = await createSoftwareControllerDriverBackend({
			...options(directory),
			databaseOptions,
		});
		// A durable commit must bypass the ordinary cache's write throttle.
		const contents = await readFile(
			join(directory, "controller.jsonl"),
			"utf8",
		);
		expect(JSON.parse(contents).v.homeId).toBe(0xdcba_4321);
		await access(join(directory, "locks", "controller.jsonl.lock"));
		await backend.destroy();
		await expect(
			access(join(directory, "locks", "controller.jsonl.lock")),
		).rejects.toThrow();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test.each([
	["state", { version: 5, homeId: 1 }],
	["unexpected", { version: 5 }],
])("rejects invalid persisted %s without replacing it", async (key, value) => {
	const directory = await mkdtemp(
		join(tmpdir(), "zwave-controller-corrupt-"),
	);
	const path = join(directory, "controller.jsonl");
	try {
		const database = db.createInstance<unknown>(path);
		await database.open();
		database.set(key, value);
		await database.flush!();
		await database.close();
		const contents = await readFile(path, "utf8");
		await expect(
			createSoftwareControllerDriverBackend(options(directory)),
		).rejects.toThrow("Invalid software controller state");
		expect(await readFile(path, "utf8")).toBe(contents);
		await database.open();
		expect(database.get(key)).toEqual(value);
		await database.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects malformed JSONL even when ordinary caches ignore read errors", async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "zwave-controller-invalid-jsonl-"),
	);
	const path = join(directory, "controller.jsonl");
	const contents = "invalid controller database\n";
	try {
		await writeFile(path, contents);
		const databaseOptions = { ignoreReadErrors: true };
		await expect(
			createSoftwareControllerDriverBackend({
				...options(directory),
				databaseOptions,
			}),
		).rejects.toThrow("Invalid data in line 1");
		expect(await readFile(path, "utf8")).toBe(contents);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects a binding without durable flush before opening its database", async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "zwave-controller-no-flush-"),
	);
	try {
		const databaseFactory: DatabaseFactory = {
			createInstance: (filename, databaseOptions) =>
				new JsonlDB(filename, databaseOptions),
		};
		await expect(
			createSoftwareControllerDriverBackend({
				...options(directory),
				host: { db: databaseFactory },
			}),
		).rejects.toThrow("durable flush support");
		expect(await readdir(directory)).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("does not expose a backend when its initial durable commit fails", async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "zwave-controller-flush-failure-"),
	);
	let restoreFlush: (() => void) | undefined;
	try {
		const databaseFactory: DatabaseFactory = {
			createInstance<V>(
				filename: string,
				databaseOptions?: DatabaseOptions<V>,
			) {
				const database = db.createInstance<V>(
					filename,
					databaseOptions,
				);
				const flush = vi
					.spyOn(database, "flush")
					.mockRejectedValueOnce(new Error("durable commit failed"));
				restoreFlush = () => flush.mockRestore();
				return database;
			},
		};
		await expect(
			createSoftwareControllerDriverBackend({
				...options(directory),
				host: { db: databaseFactory },
			}),
		).rejects.toThrow("durable commit failed");
		const reopened = await createSoftwareControllerDriverBackend(
			options(directory),
		);
		await reopened.destroy();
	} finally {
		restoreFlush?.();
		await rm(directory, { recursive: true, force: true });
	}
});
