"use strict";

const Promise = require("bluebird");
const MiddlewareHandler = require("../../src/middleware");
const ServiceBroker = require("../../src/service-broker");
const { protectReject } = require("./utils");

describe("Test MiddlewareHandler", () => {

	const broker = new ServiceBroker({ logger: false });

	it("test constructor", () => {

		let middlewares = new MiddlewareHandler(broker);

		expect(middlewares.broker).toBe(broker);
		expect(middlewares.list).toBeInstanceOf(Array);
	});

	it("test add method", () => {
		let middlewares = new MiddlewareHandler(broker);

		let mw1 = {};

		middlewares.add(mw1);
		expect(middlewares.count()).toBe(1);
		expect(middlewares.list[0]).toBe(mw1);

		middlewares.add();
		expect(middlewares.count()).toBe(1);

		let mw2 = jest.fn();

		middlewares.add(mw2);
		expect(middlewares.count()).toBe(2);
		expect(middlewares.list[1]).toEqual({
			localAction: mw2
		});
	});

	describe("Test wrapper", () => {

		let middlewares = new MiddlewareHandler(broker);

		let FLOW = [];

		let mw1 = {
			localAction: jest.fn((handler) => {
				return ctx => {
					FLOW.push("MW1-local-pre");
					return handler(ctx).then(res => {
						FLOW.push("MW1-local-post");
						return res;
					});
				};
			}),
			localEvent: jest.fn(handler => {
				return () => {
					FLOW.push("MW1-local-event-pre");
					return handler().then(res => {
						FLOW.push("MW1-local-event-post");
						return res;
					});
				};
			})
		};

		let mw2 = {};

		let mw3 = {
			localAction: jest.fn((handler) => {
				return ctx => {
					FLOW.push("MW3-local-pre");
					return handler(ctx).then(res => {
						FLOW.push("MW3-local-post");
						return res;
					});
				};
			}),
			remoteAction: jest.fn((handler) => {
				return ctx => {
					FLOW.push("MW3-remote-pre");
					return handler(ctx).then(res => {
						FLOW.push("MW3-remote-post");
						return res;
					});
				};
			})
		};

		middlewares.add(mw1);
		middlewares.add(mw2);
		middlewares.add(mw3);

		let handler = jest.fn(() => {
			FLOW.push("HANDLER");
			return Promise.resolve("John");
		});

		let action = {
			name: "posts.find",
			handler
		};

		let event = {
			name: "user.created",
			handler: jest.fn(() => {
				FLOW.push("EVENT-HANDLER");
				return Promise.resolve();
			})
		};

		it("should wrap local action", () => {

			const newHandler = middlewares.wrapHandler("localAction", handler, action);

			expect(mw1.localAction).toHaveBeenCalledTimes(1);
			expect(mw1.localAction).toHaveBeenCalledWith(handler, action);

			expect(mw3.localAction).toHaveBeenCalledTimes(1);
			expect(mw3.localAction).toHaveBeenCalledWith(jasmine.any(Function), action);
			expect(mw3.remoteAction).toHaveBeenCalledTimes(0);

			return newHandler().catch(protectReject).then(res => {
				expect(res).toBe("John");

				expect(FLOW).toEqual([
					"MW3-local-pre",
					"MW1-local-pre",
					"HANDLER",
					"MW1-local-post",
					"MW3-local-post"
				]);

			});
		});

		it("should wrap remote action", () => {
			mw1.localAction.mockClear();
			mw3.localAction.mockClear();

			FLOW = [];
			const newHandler = middlewares.wrapHandler("remoteAction", handler, action);

			expect(mw1.localAction).toHaveBeenCalledTimes(0);
			expect(mw3.localAction).toHaveBeenCalledTimes(0);
			expect(mw3.remoteAction).toHaveBeenCalledTimes(1);
			expect(mw3.remoteAction).toHaveBeenCalledWith(jasmine.any(Function), action);

			return newHandler().catch(protectReject).then(res => {
				expect(res).toBe("John");

				expect(FLOW).toEqual([
					"MW3-remote-pre",
					"HANDLER",
					"MW3-remote-post"
				]);

			});
		});

		it("should wrap local event", () => {
			FLOW = [];
			const newHandler = middlewares.wrapHandler("localEvent", event.handler, event);

			expect(mw1.localEvent).toHaveBeenCalledTimes(1);
			expect(mw1.localEvent).toHaveBeenCalledWith(event.handler, event);

			return newHandler().catch(protectReject).then(() => {
				expect(FLOW).toEqual([
					"MW1-local-event-pre",
					"EVENT-HANDLER",
					"MW1-local-event-post",
				]);

			});
		});
	});

	describe("Test calling handlers", () => {

		let middlewares = new MiddlewareHandler(broker);

		let FLOW = [];

		let mw1 = {
			created: jest.fn(() => FLOW.push("MW1-created"))
		};

		let mw2 = {
			started: jest.fn(() => Promise.delay(20).then(() => FLOW.push("MW2-started")))
		};

		let mw3 = {
			created: jest.fn(() => FLOW.push("MW3-created")),
			started: jest.fn(() => Promise.delay(20).then(() => FLOW.push("MW3-started")))
		};

		middlewares.add(mw1);
		middlewares.add(mw2);
		middlewares.add(mw3);

		it("should call sync handlers", () => {
			const obj = {};

			middlewares.callSyncHandlers("created", [obj]);

			expect(mw1.created).toHaveBeenCalledTimes(1);
			expect(mw1.created).toHaveBeenCalledWith(obj);

			expect(mw3.created).toHaveBeenCalledTimes(1);
			expect(mw3.created).toHaveBeenCalledWith(obj);

			expect(FLOW).toEqual([
				"MW1-created",
				"MW3-created"
			]);
		});

		it("should call reverted sync handlers", () => {
			mw1.created.mockClear();
			mw3.created.mockClear();

			FLOW = [];
			const obj = {};

			middlewares.callSyncHandlers("created", [obj], true);

			expect(mw1.created).toHaveBeenCalledTimes(1);
			expect(mw1.created).toHaveBeenCalledWith(obj);

			expect(mw3.created).toHaveBeenCalledTimes(1);
			expect(mw3.created).toHaveBeenCalledWith(obj);

			expect(FLOW).toEqual([
				"MW3-created",
				"MW1-created",
			]);
		});

		it("should call async handlers", () => {
			FLOW = [];

			const obj = {};

			return middlewares.callHandlers("started", [obj]).catch(protectReject).then(() => {
				expect(mw2.started).toHaveBeenCalledTimes(1);
				expect(mw2.started).toHaveBeenCalledWith(obj);

				expect(mw3.started).toHaveBeenCalledTimes(1);
				expect(mw3.started).toHaveBeenCalledWith(obj);

				expect(FLOW).toEqual([
					"MW2-started",
					"MW3-started"
				]);
			});
		});

		it("should call reverted async handlers", () => {
			mw2.started.mockClear();
			mw3.started.mockClear();

			FLOW = [];

			const obj = {};

			return middlewares.callHandlers("started", [obj], true).catch(protectReject).then(() => {
				expect(mw2.started).toHaveBeenCalledTimes(1);
				expect(mw2.started).toHaveBeenCalledWith(obj);

				expect(mw3.started).toHaveBeenCalledTimes(1);
				expect(mw3.started).toHaveBeenCalledWith(obj);

				expect(FLOW).toEqual([
					"MW3-started",
					"MW2-started",
				]);
			});
		});
	});
});

